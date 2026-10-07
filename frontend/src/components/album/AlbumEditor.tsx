import { useCallback, useState } from "react";
import type { AlbumEntry } from "../../types";
import { RETENTION_DAYS } from "../../types";
import { useEscape } from "./useEscape";
import { ConfirmDialog } from "../ConfirmDialog";

// 与 backend/config.py 的 ALBUM_MAX_* 数值同步, 改一边要同步改另一边。
const MAX_TITLE = 64;
const MAX_NOTE = 280;
const MAX_TAG_LEN = 16;
const MAX_TAGS = 8;

interface Props {
  jobId: string;
  initial: AlbumEntry;
  onSave: (patch: Partial<AlbumEntry>) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

/**
 * 单条记录的编辑抽屉。标题 / 备注 / 标签 / 收藏 / 删除。
 *
 * 标签输入: 逗号或回车提交一项, Enter 直接提交整个表单。
 * 保存按钮在 pending 期间 disabled 防止重复 PATCH。
 */
export function AlbumEditor({ jobId, initial, onSave, onDelete, onClose }: Props) {
  // 本地态由「父组件给的 key={jobId}」决定重置, 不在 effect 里同步 setState。
  //
  // 原来靠 useEffect([initial, jobId]) 重置 title/note/tags/favorite —— 那是
  // 「用 effect 派生状态」, 会多一帧旧值(用户会看到输入框先闪一下上一条的内容),
  // 并触发 react-hooks/set-state-in-effect。改成 key 重挂载后, 换一条记录时
  // React 直接重建组件, useState(initial.x) 天然就是新值。
  //
  // 注意语义差异(刻意保留): 保存成功后父组件会 reload() 拉回新 items,
  // 同一条记录的 initial 内容会更新(如 updated_at), 但 jobId 不变 → 不重挂载
  // → 用户刚编辑的内容不会被回滚。这比原实现更正确: 原实现会在 reload 之后
  // 立刻把输入框重置成服务端值, 用户刚敲的字就消失了。
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [favorite, setFavorite] = useState(initial.favorite);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * 确认态里显示的保留期提示。
   *
   * 天数是**从后端配置里抄过来的常量**而不是从接口拿: 回收站的列表接口
   * 才有 retention_days, 而这里是删除前的瞬时提示, 为此多发一个请求不划算。
   * 两者不一致的代价只是文案少写一个数字(仍会正确显示"移到回收站"),
   * 而多一次请求会让确认态有可感知的延迟。
   */
  const RETENTION_HINT = `${RETENTION_DAYS} 天后可从回收站恢复`;

  function addTag(raw: string) {
    const t = raw.trim();
    if (!t) return;
    if (tags.includes(t)) return;
    if (tags.length >= MAX_TAGS) return;
    setTags([...tags, t]);
    setTagInput("");
  }

  /**
   * 内容是否真的被改过。
   *
   * 拿它给保存按钮置灰。**后端也拦一道**(见 gallery_patch 的 _same_content),
   * 但两道不是冗余: 后端拦的是数据正确性, 前端拦的是交互反馈 ——
   * 用户点一下看到按钮变灰、提示「无改动」, 比点了之后拿到一个
   * 「已保存但什么都没变」的响应要清楚得多。
   *
   * tags 必须逐位比而不是直接 `!==`: 数组每次渲染都是新引用, 直接比会
   * 恒为「有变化」, 按钮就永远可点, 置灰逻辑等于不存在。
   */
  const dirty =
    title !== initial.title ||
    note !== initial.note ||
    favorite !== initial.favorite ||
    tags.length !== initial.tags.length ||
    tags.some((t, i) => t !== initial.tags[i]);

  // Esc 关闭。pending 期间不关: PATCH/DELETE 正在飞, 关掉抽屉会让用户
  // 以为操作没生效, 而后台其实已经把数据改了。
  //
  // **删除确认弹窗开着时必须让出Esc**: 这个 hook 挂的是 document, 而
  // ConfirmDialog 内部也挂了一个。按一次 Esc 会让两个 handler 都跑,
  // 于是 requestClose 把整个编辑抽屉关掉 —— "按 Esc 取消删除"就变成了
  // "取消删除 + 顺带丢掉未保存的编辑"。这是很隐蔽的数据丢失路径:
  // 用户只是想取消删除, 标题和标签的修改却一起没了。
  const requestClose = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);
  useEscape(requestClose, !confirmDelete);

  async function handleSave() {
    setPending(true);
    try {
      await onSave({ title, note, tags, favorite });
      onClose();
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    setPending(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-cream rounded-2xl border-2 border-pink p-5 max-w-md w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3">
          <div className="font-pixel text-brick" data-testid="album-edit-title" data-job-id={jobId}>
            编辑 · {jobId.slice(0, 8)}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-brown/60 hover:text-brick text-xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <label className="block text-xs text-brown/70 mb-1">标题 (≤{MAX_TITLE})</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, MAX_TITLE))}
          maxLength={MAX_TITLE}
          data-album-title=""
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-3"
        />

        <label className="block text-xs text-brown/70 mb-1">备注 (≤{MAX_NOTE})</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE))}
          maxLength={MAX_NOTE}
          data-album-note=""
          rows={3}
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-3 resize-none"
        />

        <label className="block text-xs text-brown/70 mb-1">
          标签 ({tags.length}/{MAX_TAGS}, 回车添加)
        </label>
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value.slice(0, MAX_TAG_LEN))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(tagInput);
            }
            if (e.key === "Backspace" && !tagInput && tags.length) {
              setTags(tags.slice(0, -1));
            }
          }}
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-2"
        />
        <div className="flex flex-wrap gap-1 mb-3 min-h-[24px]">
          {tags.map((t) => (
            <span
              key={t}
              className="bg-pink/40 text-brown text-xs px-2 py-0.5 rounded-full flex items-center gap-1"
            >
              {t}
              <button
                type="button"
                onClick={() => setTags(tags.filter((x) => x !== t))}
                aria-label={`删 ${t}`}
                className="hover:text-brick"
              >
                ×
              </button>
            </span>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-brown mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={favorite}
            onChange={(e) => setFavorite(e.target.checked)}
            className="w-4 h-4 accent-brick"
          />
          收藏(置顶显示)
        </label>

        <div className="flex gap-2">
          {/*
            删除入口只负责打开确认弹窗, 不再有第二段按钮。

            早先是"就地换成『移到回收站』" —— 那个变化太小, 用户常要点第二下
            才发现自己在哪一步。现在由 ConfirmDialog 承接(批量删除那边同样
            改成了弹窗, 两处必须一致, 否则同一种操作有两种心智模型)。
          */}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={pending}
            className="px-3 py-2 text-xs text-red-500 border border-red-300 rounded-full hover:bg-red-50 disabled:opacity-40"
            data-album-delete=""
          >
            删除这条
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            data-album-cancel=""
            className="px-4 py-2 text-sm border border-pink rounded-full"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={pending || !dirty}
            data-album-save=""
            className="px-4 py-2 text-sm bg-brick text-white rounded-full disabled:opacity-50"
            title={dirty ? "" : "内容没有改动"}
          >
            {pending ? "保存中..." : dirty ? "保存" : "无改动"}
          </button>
        </div>
      </div>

      {/*
        删除确认弹窗。挂在**最外层遮罩里、内层卡片之外** —— 放错位置的话
        它会继承卡片的 `max-w-md` 与 `stopPropagation`, 变成"卡片里又一张
        卡片", 且点确认按钮不会触发遮罩的关闭逻辑。

        层级: 本组件遮罩与 ConfirmDialog 都是 z-50, 靠 DOM 顺序决定 ——
        弹窗在后面, 于是盖在编辑抽屉之上, 正是所需。
      */}
      <ConfirmDialog
        open={confirmDelete && !pending}
        title="移到回收站?"
        message="将这条照片移到回收站。"
        hint={RETENTION_HINT}
        confirmLabel="移到回收站"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
        testId="album"
      />
    </div>
  );
}