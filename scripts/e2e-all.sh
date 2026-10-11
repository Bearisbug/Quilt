#!/bin/zsh
# 全量轮（TEST.md §5）：起测试栈 → 九个套件依次跑 → 停栈 → install 套件（它自己起打包形态的服务）。
# 用法：RUN=<轮次号> scripts/e2e-all.sh [lane]（lane 缺省 main，见 e2e-stack.sh）；输出只留结果行与各套件的汇总，完整日志在 .e2e/<lane>/run-<RUN>.log。
# 跑之前先构建前端（pnpm --filter @quilt/web build）：测试栈托管的是 apps/web/dist。
lane=${1:-main}
REPO=${0:A:h:h}
S=$REPO/scripts/e2e-stack.sh
: ${RUN:?先设 RUN=<轮次号>}
FULL=$REPO/.e2e/$lane/run-$RUN.log
cd $REPO/tests
$S $lane restart || exit 1
eval "$($S $lane env)"
export RUN
: > $FULL
F='^(✅|❌|⏭|🟡)|^=== RUN-|^最慢|^   - '
for suite in core load canvas proto edit components agent mcp chat; do
  echo "### $suite $(date +%T)"
  echo "### $suite $(date +%T)" >> $FULL
  npx tsx e2e/$suite.ts 2>&1 | tee -a $FULL | grep --line-buffered -E "$F"
done
$S $lane stop
echo "### install $(date +%T)"
env -u npm_config_allow_scripts node --import tsx e2e/install.ts 2>&1 | tee -a $FULL | grep --line-buffered -E "TC-CORE-031|=== RUN-"
echo "### done $(date +%T)（完整日志 $FULL）"
