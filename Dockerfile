# ---------------------------------------------------------------------------
# mcstatus-api —— 容器镜像
#
# 构建： docker build -t mcstatus-api .
# 运行： docker run -d --name mcstatus-api -p 3001:3001 \
#          -e OVERVIEW_SERVERS="主服@play.example.com:25565:25566" mcstatus-api
#
# 说明：
#   - 中文字体不用额外装，项目自带 HarmonyOS Sans SC（assets/fonts，约 47MB）
#   - emoji 字体要装两套：彩色那套不一定能被 cairo 栅格化，单色那套是稳定兜底
#   - node-canvas 用的是预编译包，Linux 上不需要编译工具链
# ---------------------------------------------------------------------------

FROM node:20-slim

# 字体：
#   - 中文字体不用装，项目自带 HarmonyOS Sans SC（assets/fonts，约 47MB）
#   - DejaVu：提供 ★ ☆ ✓ 这类符号（slim 镜像默认没有任何系统字体，缺了会画成方框）
#   - Noto Color Emoji：彩色 emoji（CBDT 位图字体），cairo 支持时优先用它
#   - Symbola：单色轮廓字体、覆盖面很广。彩色那套在部分 cairo/FreeType 上会画成空白或方框，
#     这时程序会自动退到这套；两套都用不了才会跳过 emoji 不画
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
        fonts-symbola \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，充分利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷源码与字体
COPY . .

ENV NODE_ENV=production \
    PORT=3001 \
    BANNER_DEFAULT_SCALE=2

EXPOSE 3001

# 服务只读运行，不需要写盘
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
