#!/bin/zsh
# e2e 隔离测试栈（TEST.md §3）。用法：scripts/e2e-stack.sh <lane> <start|stop|restart|status|env>
#   lane = main：测试库 quilt_test、端口 3410 / 3411；lane = l1…l9：测试库 quilt_l<N>_test、端口 3410+10N / 3411+10N，库不存在就建。
#   绝不碰开发实例（3100 / 3101 / 6688）与开发库 quilt：库名一律以 _test 结尾，tests/e2e/lib.ts 的 assertTestApi 只认这种库名。
#   跑的是本脚本所在仓库（或 worktree）的代码；状态（API 日志、假会话与假 Codex 目录）在 <仓库>/.e2e/<lane>/，已 gitignore。
#   QUILT_RATE_LIMIT_PER_MIN 缺省 1000（stub 下的限流旋钮）；调用方的环境里给了就用给的（restartApi 按 10 重启验限流）。
lane=$1; cmd=$2
case $lane in
  main) DB=quilt_test; API=3410; PRV=3411 ;;
  l[1-9]) n=${lane#l}; DB=quilt_l${n}_test; API=$((3410 + 10 * n)); PRV=$((3411 + 10 * n)) ;;
  *) echo "lane 是 main 或 l1…l9"; exit 2 ;;
esac
WT=${0:A:h:h}
DIR=$WT/.e2e/$lane
LOG=$DIR/api.log
mkdir -p $DIR/sessions $DIR/codex
DBURL=postgres://quilt:quilt@127.0.0.1:5439/$DB
stop() {
  # 先去重：API 与预览两个端口是同一个进程。父进程取到 1（已成孤儿 / 僵尸被 launchd 收养）就别再往上取——
  # 1 的父进程是 0，kill -9 0 会把调用方整个进程组一起杀掉（回归脚本、e2e 进程跟着没了，且没有任何报错）
  local pids=($(lsof -nP -tiTCP:$API -sTCP:LISTEN) $(lsof -nP -tiTCP:$PRV -sTCP:LISTEN))
  for p in ${(u)pids}; do
    pp=$(ps -o ppid= -p $p | tr -d " "); gp=""
    [[ -n $pp && $pp -gt 1 ]] && gp=$(ps -o ppid= -p $pp | tr -d " ")
    pkill -9 -P $p 2>/dev/null  # 截图浏览器是 API 的子进程，只杀 API 的话它会变成孤儿一直挂着
    for k in $p $pp $gp; do [[ -n $k && $k -gt 1 ]] && kill -9 $k 2>/dev/null; done
  done
  sleep 1
}
ensure_db() {
  [[ $DB == quilt_test ]] && return
  (cd $WT/apps/api && node -e "
    const pg = require('pg'); const c = new pg.Client({ connectionString: 'postgres://quilt:quilt@127.0.0.1:5439/postgres' });
    c.connect().then(() => c.query(\"select 1 from pg_database where datname = '$DB'\"))
      .then((r) => r.rowCount ? null : c.query('create database $DB'))
      .then(() => c.end(), (e) => { console.error(e.message); process.exit(1); });")
}
start() {
  if lsof -nP -iTCP:$API -sTCP:LISTEN >/dev/null; then echo "已在运行 :$API"; return; fi
  ensure_db || return 1
  (cd $WT && env DATABASE_URL=$DBURL API_PORT=$API PREVIEW_PORT=$PRV \
    API_ORIGIN=http://localhost:$API WEB_ORIGIN=http://localhost:$API PREVIEW_ORIGIN=http://preview.localhost:$PRV \
    WEB_DIST=$WT/apps/web/dist LLM_DRIVER=stub LLM_STUB= QUILT_RATE_LIMIT_PER_MIN=${QUILT_RATE_LIMIT_PER_MIN:-1000} \
    QUILT_CLAUDE_SESSIONS_DIR=$DIR/sessions QUILT_CODEX_HOME=$DIR/codex \
    QUILT_CODEX_BIN=$WT/tests/e2e/codex-stub.mjs QUILT_CODEX_OPENER=$WT/tests/e2e/codex-stub.mjs OPENAI_API_KEY=sk-must-not-reach-codex \
    nohup pnpm --filter @quilt/api dev > $LOG 2>&1 &)
  for i in {1..60}; do sleep 1; curl -s --noproxy '*' http://localhost:$API/v1/health 2>/dev/null | grep -q "\"database\":\"$DB\"" && { echo "ok :$API db=$DB（日志 $LOG）"; return; }; done
  echo "启动失败，看 $LOG："; tail -20 $LOG; return 1
}
case $cmd in
  start) start ;;
  stop) stop; echo stopped ;;
  restart) stop; start ;;
  status) curl -s --noproxy '*' http://localhost:$API/v1/health; echo ;;
  env) # 给 e2e / 脚本用：eval "$(scripts/e2e-stack.sh main env)"
    echo "export DATABASE_URL=$DBURL QUILT_E2E_API=http://localhost:$API QUILT_E2E_WEB=http://localhost:$API LIVE_LLM=0 GEMINI_API_KEY= QUILT_CLAUDE_SESSIONS_DIR=$DIR/sessions QUILT_CODEX_HOME=$DIR/codex QUILT_E2E_RESTART='$WT/scripts/e2e-stack.sh $lane restart'" ;;
  *) echo "cmd: start|stop|restart|status|env"; exit 2 ;;
esac
