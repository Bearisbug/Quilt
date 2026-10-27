import { useEffect, useState, type RefObject } from 'react';
import type { ComposerHandle } from './Composer';
import { useComposerDock } from './useComposerDock';

// 画布外壳上输入框的停靠与收起（useComposerDock，记在本机），以及由它换算出的画布安全区与 toast 落点；全屏视图另记一份
export function useComposerChrome(focusedId: string | null, composerRef: RefObject<ComposerHandle | null>, page: 'canvas' | 'fullview' = 'canvas') {
  // 输入框收起（v0.33，v1.16 收成贴边胶囊、记在本机）：⌘/、工具栏「输入框」与输入框右上角的「收起」是同一开关。
  // 聚焦某屏时自动收起（把屏底让出来）、⌘/ 可临时叫出，退出聚焦回到画布态的值——聚焦引起的收起不写进记忆
  const composerDock = useComposerDock(page);
  const [composerInFocus, setComposerInFocus] = useState(false);
  useEffect(() => { setComposerInFocus(false); }, [focusedId]);
  const composerVisible = focusedId ? composerInFocus : !composerDock.prefs.collapsed;
  const showComposer = () => { if (focusedId) setComposerInFocus(true); else composerDock.setCollapsed(false); setTimeout(() => composerRef.current?.focus(), 0); };
  const toggleComposer = () => { if (!composerVisible) showComposer(); else if (focusedId) setComposerInFocus(false); else composerDock.setCollapsed(true); };
  // toast 浮在输入框上方（v0.74；停在左右边时距底 1.5rem，v1.16）。toast 挂在根上，读不到外壳上的 --chrome-bottom，算好的数写到 <html> 上
  const toastBottom = composerDock.toastBottom;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--toast-bottom', `${toastBottom}px`);
    return () => { root.removeProperty('--toast-bottom'); };
  }, [toastBottom]);
  return { composerVisible, showComposer, toggleComposer, composerDock };
}
