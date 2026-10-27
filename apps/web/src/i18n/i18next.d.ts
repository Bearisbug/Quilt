import 'i18next';
import type canvasPage from './locales/canvas-page';
import type canvasParts from './locales/canvas-parts';
import type collab from './locales/collab';
import type common from './locales/common';
import type composer from './locales/composer';
import type fullview from './locales/fullview';
import type panelsDesign from './locales/panels-design';
import type panelsInspect from './locales/panels-inspect';
import type preview from './locales/preview';
import type settings from './locales/settings';
import type shellLib from './locales/shellLib';
import type shellPages from './locales/shellPages';
import type shellProject from './locales/shellProject';
import type shellUi from './locales/shellUi';
import type sketch from './locales/sketch';
import type twclass from './locales/twclass';

// i18next 自己的类型（REQ-CORE-046）：让直接用 i18next / react-i18next 的地方（<Trans i18nKey>、useTranslation、i18next.t）也按键检查。
// 键以中文为准，英文由 defineMessages 保证同一套键；locales/ 新增命名空间文件时在这里补一行，键名 = defineMessages 的第一个参数
// （useT / tOf 只收这里登记过的命名空间，漏登记在调用处编译不过）
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      'canvas-page': typeof canvasPage.zh;
      'canvas-parts': typeof canvasParts.zh;
      collab: typeof collab.zh;
      common: typeof common.zh;
      composer: typeof composer.zh;
      fullview: typeof fullview.zh;
      'panels-design': typeof panelsDesign.zh;
      'panels-inspect': typeof panelsInspect.zh;
      preview: typeof preview.zh;
      settings: typeof settings.zh;
      shellLib: typeof shellLib.zh;
      shellPages: typeof shellPages.zh;
      shellProject: typeof shellProject.zh;
      shellUi: typeof shellUi.zh;
      sketch: typeof sketch.zh;
      twclass: typeof twclass.zh;
    };
  }
}
