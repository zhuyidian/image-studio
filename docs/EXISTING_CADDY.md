# 使用服务器现有 Docker Caddy 部署图片站

此方案针对用户已提供的服务器清单：`yidian-api-caddy-1`（`caddy:2.10-alpine`）占用公网 80/443，主站、文章站、New API 均为已有容器。图片站全新数据库上线，不复制本地账号、积分、素材或模型目录。

## 1. 先确认现有网络与配置来源

在 Ubuntu 服务器终端执行只读检查：

```bash
sudo docker inspect yidian-api-caddy-1 --format '{{range $name, $settings := .NetworkSettings.Networks}}{{println $name}}{{end}}'
sudo docker inspect yidian-api-caddy-1 --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

选择 Caddy 所在的现有 Docker bridge 网络，将实际名称填写到 `.env.production` 的 `PROXY_NETWORK`。不要根据容器名猜测网络名。如果只看到 host/none 网络，需要改用对应网络模式方案，不能套用本文件。

挂载信息用于确定服务器上真正需要编辑的 Caddy 配置文件或目录。不要只在容器可写层临时编辑，也不要用项目的 Caddyfile 覆盖服务器已有全部站点。配置如果由面板生成，应通过原面板增加站点。

## 2. 上传源码与生产配置

将包含 `compose.external-proxy.yaml` 的最新源码上传到例如 `/opt/yidian-image`。不上传 `.env`、`data/`、`node_modules/`、`dist/`。代码打包前确保新部署文件已经提交，`git archive HEAD` 只包含已提交文件。

从 `deploy/production.env.example` 创建服务器私密 `.env.production`，填写：

- `PROXY_NETWORK=上一步查到的现有网络名`
- `APP_ORIGIN=https://image.yidianhub.com`
- `PUBLIC_ORIGIN=https://image.yidianhub.com`
- `IMAGE_PROVIDER=newapi`
- `NEW_API_BASE_URL=https://api.yidianhub.com/v1`
- `NEW_API_KEY=图片站专用受限Key`
- `NEW_API_IMAGE_MODEL=gpt-image-2`
- `TRUST_PROXY_HOPS=1`：适用于客户端只经这个 Caddy 到应用；如有 CDN 再按实际代理链检查。
- `MAIL_TRANSPORT=smtp` 与已验证的 QQ SMTP 配置，授权码只放服务器配置。
- 初始 `ALLOW_REGISTRATION=false`、`SIGNUP_CREDITS=0`、`EMAIL_VERIFICATION_REQUIRED=true`。
- `WORKER_CONCURRENCY=1`，先保守运行，再按服务器负载调整。
- `PAYMENT_PROVIDER=disabled`。

生产设置不要使用本机 `127.0.0.1:5173`。配置文件建议权限 600。模型单价环境变量只初始化默认目录，后续在后台调整。

## 3. 构建并启动单独图片站

所有命令都从 `/opt/yidian-image` 执行，并使用同一个 Compose 文件：

```bash
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml up -d --build app
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml ps
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml logs --tail=100 app
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml exec app node -e "fetch('http://127.0.0.1:8787/api/health').then(async r=>{console.log(await r.text());if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)"
```

独立项目名为 `yidian-image`，数据卷为 `yidian-image_studio-data`。图片容器仅在 Docker 网络暴露 8787，没有宿主机端口映射，也不启动另一套 Caddy；无需占用或公网开放 5173/8787/8788。现有中转站、主站与文章站 Compose 项目不需要重新部署。

## 4. 接入现有 Caddy

先让 `image.yidianhub.com` 解析到这台服务器。备份上一步查到的现有 Caddy 配置文件，在正确的配置位置**增加** `deploy/Caddyfile.image.example` 中的域名块：

```caddyfile
image.yidianhub.com {
    encode zstd gzip
    request_body {
        max_size 21MB
    }
    reverse_proxy yidian-image-web:8787
}
```

`yidian-image-web` 是图片站在共享 Docker 网络中的专用别名，避免和其他项目的 `app` 别名冲突。不要填写 `127.0.0.1:8787`：从 Caddy 容器看来，它指向 Caddy 自己。

如果现有 Caddy 确实以 `/etc/caddy/Caddyfile` 为入口，添加配置后先验证，再平滑加载：

```bash
sudo docker exec yidian-api-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker exec yidian-api-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -fsS https://image.yidianhub.com/api/health
```

必须确认 validate 成功后再执行 reload。入口不同时使用实际路径。现有 Caddy 管理该域名证书，图片站不另外申请或绑定 80/443。

## 5. 全新管理员与模型

新站没有本地管理员。SMTP 与 HTTPS 正常后：

```bash
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml exec app node dist/scripts/admin.js registration true
# 在图片站验证邮箱、注册自己的账户后：
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml exec app node dist/scripts/admin.js promote "你的注册邮箱"
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml exec app node dist/scripts/admin.js registration false
```

后台配置首批 GPT Image 2：标准、方形、单张、每张 12 积分，选择已验证的生图/编辑/重绘能力，quality 标准映射 medium，保留 size 请求及实际 1254×1254 的尺寸说明。全新目录默认不开放，管理员可先用测试入口核验服务器到上游的链路，成功后再启用。真实模型测试有费用，不能把模型列表查询当作真实出图验收。

在后台生成兑换码并兑换给管理员/试用用户。普通用户只注册图片站，统一使用服务器 `.env.production` 的服务 Key，无需同步创建 New API 账户。

## 6. 更新、备份与回退

后续使用同一个项目目录、Compose 文件和数据卷更新：

```bash
sudo docker compose --env-file .env.production -f compose.external-proxy.yaml up -d --build app
```

`.env.production` 改动用上述命令重新创建 app，使环境变量生效。不要使用 `down -v`，它会删除数据卷。更新前备份数据库与媒体，保留原镜像/源码版本。现有项目不受此图片站命令控制。

生产备份可调用镜像内 `dist/server/backup.js` 的 `createBackup` / `verifyBackup`，或在维护窗口停止 app 后备份整个图片数据卷；不能只复制正在写入的 SQLite 主文件。备份复制到私有异地存储，并验证恢复。密钥独立保存，不放入源码归档。

## 当前验收边界

该文件准备了部署模板和操作步骤，没有连接服务器、修改现有 Caddy、DNS 或执行镜像构建。现有网络名、挂载位置与可用资源必须通过服务器输出确认后再执行对应步骤。
