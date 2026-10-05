import { useEffect, useState } from "react";
import type { AlbumEntry } from "../../types";

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
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [favorite, setFavorite] = useState(initial.favorite);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 当 initial 变化(从不同 item 打开)时重置本地态
  useEffect(() => {
    setTitle(initial.title);
    setNote(initial.note);
    setTags(initial.tags);
    setFavorite(initial.favorite);
    setTagInput("");
    setConfirmDelete(false);
  }, [initial, jobId]);

  function addTag(raw: string) {
    const t = raw.trim();
    if (!t) return;
    if (tags.includes(t)) return;
    if (tags.length >= MAX_TAGS) return;
    setTags([...tags, t]);
    setTagInput("");
  }

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
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-3"
        />

        <label className="block text-xs text-brown/70 mb-1">备注 (≤{MAX_NOTE})</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE))}
          maxLength={MAX_NOTE}
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
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
              className="px-3 py-2 text-xs text-red-500 border border-red-300 rounded-full hover:bg-red-50"
            >
              删除这条
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="px-3 py-2 text-xs bg-red-500 text-white rounded-full hover:bg-red-600"
            >
              确认删除? 不可恢复
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-4 py-2 text-sm border border-pink rounded-full"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="px-4 py-2 text-sm bg-brick text-white rounded-full disabled:opacity-50"
          >
            {pending ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}