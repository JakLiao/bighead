import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { DecoratePage } from "./pages/DecoratePage";
import { GalleryPage } from "./pages/GalleryPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-cream/80 backdrop-blur border-b border-pink/60">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
          <div className="font-pixel text-brick text-lg tracking-wider">BIGHEAD</div>
          <nav className="flex gap-3 ml-4 text-sm">
            <Tab to="/home">拍照</Tab>
            <Tab to="/decorate">排版</Tab>
            <Tab to="/gallery">画廊</Tab>
            <Tab to="/settings">设置</Tab>
          </nav>
          <div className="ml-auto text-xs text-brown/70 font-mono-retro text-base">
            空格 = 拍照 · Esc = 退出
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/decorate" element={<DecoratePage />} />
          <Route path="/gallery" element={<GalleryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded-full border ${
          isActive
            ? "bg-brick text-white border-brick"
            : "bg-white/70 text-brown border-pink hover:bg-pink/40"
        } transition`
      }
    >
      {children}
    </NavLink>
  );
}
