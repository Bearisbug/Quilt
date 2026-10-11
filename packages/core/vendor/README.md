# 屏文档引用的外网脚本副本

预览域与截图用这里的副本，不走外网（设计文档 §17、§28，v1.06）。修订 HTML 里仍写钉死版本的外网地址，导出件与屏单独打开时照样可用。

| 文件 | 来源 | 许可 | sha256 |
| --- | --- | --- | --- |
| `tailwind-play-3.4.17.js` | https://cdn.tailwindcss.com/3.4.17（Tailwind CSS Play CDN） | MIT | `176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15` |
| `lucide-1.55.0.min.js` | https://unpkg.com/lucide@1.55.0/dist/umd/lucide.min.js | ISC | `48b3b5d82216bbe1d0c49dea480ed38fca8420c275c98f20505e3f9556f6b1d1` |

换版本：下载新文件、改 `packages/core/src/prelude.ts` 的 `VENDOR`、更新本表，跑 `TC-CORE-095`。
