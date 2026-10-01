import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { ComposerHandle } from './Composer';

const CHAT_KEY = 'quilt:chat-collapsed';
// toast 列（lib/toast.tsx）：水平居中、单条限宽 28rem、两侧留 1rem
const TOAST_W = 28 * 16;
const TOAST_GAP = 16;

// 画布外壳上两块浮层的显隐：对话记录折叠（跨会话记忆）、输入框显隐（只在本次会话内），以及输入框高度换算成的画布底部占位。
// panelOpen：右侧面板开合会把对话记录挪到输入框上方或挪回左下角（styles.css 的 77.25rem 断点），toast 的落点要跟着重量
export function useComposerChrome(focusedId: string | null, composerRef: RefObject<ComposerHandle | null>, panelOpen: boolean) {
  // 对话记录折叠：属于个人视图偏好，跨会话记忆；首帧即取到正确值、读写容错（INT-007 / INT-021）
  const [chatCollapsed, setChatCollapsed] = useState(() => { try { return localStorage.getItem(CHAT_KEY) === '1'; } catch { return false; } });
  const toggleChat = () => setChatCollapsed((v) => { try { localStorage.setItem(CHAT_KEY, v ? '0' : '1'); } catch { /* 无痕模式写不了，退化为仅本次会话有效 */ } return !v; });
  // 输入框显隐（v0.33）：画布态由 ⌘/ 收起或叫回；聚焦某屏时默认收起（把屏底让出来）、⌘/ 可临时叫出，退出聚焦回到画布态的值。
  // 收起只是不显示（草稿与参考图留着），不跨会话记忆——它是主输入控件，刷新后总该在。
  const [composerHidden, setComposerHidden] = useState(false);
  const [composerInFocus, setComposerInFocus] = useState(false);
  useEffect(() => { setComposerInFocus(false); }, [focusedId]);
  const composerVisible = focusedId ? composerInFocus : !composerHidden;
  const showComposer = () => { if (focusedId) setComposerInFocus(true); else setComposerHidden(false); setTimeout(() => composerRef.current?.focus(), 0); };
  const toggleComposer = () => { if (!composerVisible) showComposer(); else if (focusedId) setComposerInFocus(false); else setComposerHidden(true); };
  // 输入框实际高度 → 画布安全区底部占位（--chrome-bottom = 高度 + 16px 底距 + 16px 间隙）；收起时不设，让样式表的 1rem 生效
  const [composerH, setComposerH] = useState<number | null>(null);
  const shellStyle = composerVisible && composerH ? ({ '--chrome-bottom': `${Math.round(composerH) + 32}px` } as CSSProperties) : undefined;
  // toast 浮在输入框上方（v0.74）；对话记录折叠成的横条落在 toast 那一列底下时也让开它（v0.83）——窄视口里横条叠在输入框上方，
  // 输入框收起时横条落到底部，toast 照旧贴着输入框（或底边 1.5rem）就正好压住横条和它上面的「N 轮失败」。
  // toast 挂在根上，读不到外壳上的 --chrome-bottom，算好的数写到 <html> 上
  const dockRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = document.documentElement.style;
    const place = () => {
      let bottom = composerVisible && composerH ? Math.round(composerH) + 32 : 24;
      const bar = chatCollapsed ? dockRef.current?.getBoundingClientRect() : null;
      const col = Math.min(TOAST_W, window.innerWidth - 32);
      const colLeft = (window.innerWidth - col) / 2;
      if (bar && bar.width && bar.right > colLeft && bar.left < colLeft + col) bottom = Math.max(bottom, Math.round(window.innerHeight - bar.top) + TOAST_GAP);
      root.setProperty('--toast-bottom', `${bottom}px`);
    };
    place();
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('resize', place); root.removeProperty('--toast-bottom'); };
  }, [composerVisible, composerH, chatCollapsed, panelOpen]);
  return { chatCollapsed, toggleChat, composerVisible, showComposer, toggleComposer, composerH, setComposerH, shellStyle, dockRef };
}
