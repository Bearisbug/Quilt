import { EmptyState } from '../components/ui';
import { TopNav } from '../components/TopNav';
import { BrandSymbol } from '../components/BrandMark';
import { CreateProjectDialog } from '../components/CreateProjectDialog';

// PAGE-FIRST（§13）：还没有任何项目时 `/` 落到这里——只有新建弹窗，没有别处可去，所以弹窗不可关闭；
// 有项目时 `/` 的 loader 直接跳最近更新的项目，画布顶栏的项目切换器承担原项目列表的职责。
// 这是 `npx quilt-canvas` 首次打开看到的第一屏，也是产品里唯一放得下 64 px 完整品牌符号的地方（BRAND.md §5）。
export function FirstProjectPage() {
  return (
    <div className="flex h-full flex-col">
      <TopNav />
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
        <BrandSymbol size={96} label="Quilt" />
        <EmptyState title="还没有项目" hint="新建一个项目，用一句话描述你的 APP，Quilt 会生成整套屏幕摆到画布上。" />
      </main>
      <CreateProjectDialog />
    </div>
  );
}
