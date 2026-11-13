# GitHub 构建版本 → GHCR 镜像 → 服务器拉取部署

仓库：<https://github.com/zhuyidian/image-studio>。镜像：`ghcr.io/zhuyidian/image-studio`。

服务器沿用现有 `yidian-api-caddy-1`，共享网络 **`yidian-api_frontend`**。本流程全新上线，不迁移本地账号、积分、图片和后台配置。服务器不需要 Node、npm、源码或本地编译，只需要 Docker Compose。

## 一、发布流程

- 推送 main、codex 分支或创建 PR：CI 执行 `npm ci`、全部测试、生产构建、Docker 构建与运行检查。
- 推送版本标签（例如 `v0.1.0`）：先重复版本校验与上述检查，通过后发布 Linux amd64/arm64 镜像；再按镜像 digest 拉回实际发布的 amd64 镜像，检查启动和重启后的数据持久化，通过后创建 Release。
- GitHub Actions 自动创建 GitHub Release，附带部署包、SHA256SUMS 和 release-manifest.json。
- 部署包中的 `YIDIAN_IMAGE` 固定为这次镜像的 `sha256` digest，服务器拉到的是已发布的对应镜像，不随 latest 变化。
- 发布标签必须与 package.json 的 version 一致；未来发布应先更新 version，再提交并创建新标签。不要移动已发布的版本标签。
- 所有验证均使用模拟图片提供者，不需要在 GitHub 配置 New API 或 SMTP 密钥，不产生真实模型费用。

首次发布需要确保仓库 Actions 允许运行。工作流使用仓库自动提供的 `GITHUB_TOKEN`：发布镜像需要 packages:write，创建 Release 需要 contents:write。生产环境密钥无需加入 GitHub Secrets。

## 二、GHCR 首次拉取权限

GitHub 仓库公开不代表新建 GHCR 包自动公开。首次发布后，检查 GitHub 个人主页 Packages → image-studio → Package settings：

- 希望服务器匿名拉取：把镜像包设为 Public。
- 希望镜像保持私有：在服务器用有 read:packages 权限的 GitHub PAT 登录；若涉及组织，还须满足组织授权要求。

服务器登录命令（交互式输入 token，不把 token 写在命令历史里）：

```bash
sudo docker login ghcr.io -u zhuyidian
```

Token 不等于 GitHub 登录密码，也不是 New API Key。此认证仅用于拉镜像。repo clone 的权限和 GHCR 拉取权限分别管理。

## 三、服务器下载发布部署包

确认 Actions 和 Releases 中 **v0.1.0 已成功发布**后，在服务器执行：

```bash
sudo mkdir -p /opt/yidian-image
sudo chown ubuntu:ubuntu /opt/yidian-image
cd /opt/yidian-image
mkdir -p releases/v0.1.0
cd releases/v0.1.0

curl -fL --retry 3 -o yidian-image-v0.1.0-deploy.tar.gz https://github.com/zhuyidian/image-studio/releases/download/v0.1.0/yidian-image-v0.1.0-deploy.tar.gz
curl -fL --retry 3 -o SHA256SUMS https://github.com/zhuyidian/image-studio/releases/download/v0.1.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf yidian-image-v0.1.0-deploy.tar.gz

cd /opt/yidian-image
cp releases/v0.1.0/compose.yaml compose.yaml
cp -n releases/v0.1.0/production.env.example .env.production
chmod 600 .env.production
nano .env.production
```

上述用户 ubuntu 来自已确认的服务器登录账号；若实际用户不同，相应修改所有者。仅操作图片站目录，不修改旧站目录。已有图片站运行时，应先备份原 Compose/环境配置再更新，不能将旧数据目录当作空目录覆盖。

部署包只含 Compose、环境变量示例、Caddy 片段、说明与镜像清单，不含源码。不要将 GitHub 自动生成的 Source code 压缩包当部署包。

示例已预填网络、域名和镜像 digest。首次只填写：

```dotenv
NEW_API_KEY=图片站专用NewAPI服务Key
SMTP_USER=你的发信QQ邮箱
SMTP_PASS="已验证的QQ邮箱SMTP授权码"
SMTP_FROM=与SMTP_USER相同的QQ邮箱
```

保留 `APP_ORIGIN` 和 `PUBLIC_ORIGIN` 为 `https://image.yidianhub.com`，`PROXY_NETWORK=yidian-api_frontend`，`PAYMENT_PROVIDER=disabled`。保持注册初始关闭、赠送积分为 0。New API 和 SMTP 变量只留在服务器的私密配置，不放入 GitHub 或镜像。

## 四、服务器拉取并启动

从 `/opt/yidian-image` 执行：

```bash
sudo docker compose --env-file .env.production pull app
sudo docker compose --env-file .env.production up -d --no-build --wait --wait-timeout 120 app
sudo docker compose --env-file .env.production ps
sudo docker compose --env-file .env.production logs --tail=80 app
sudo docker compose --env-file .env.production exec app node -e "fetch('http://127.0.0.1:8787/api/health').then(async r=>{console.log(await r.text());if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)"
```

只启动图片站 app，不启动任何新的 Caddy、数据库或 New API。项目名 `yidian-image`，独立数据卷 `yidian-image_studio-data`。图片站没有宿主机端口映射，现有站点继续使用原端口。

拉取提示 denied/unauthorized：先检查镜像包是否公开，或执行上面的 docker login；不要因此更换图片站的 New API Key。外部网络不存在：核对 `sudo docker network inspect yidian-api_frontend`。构建/启动错误请保留 logs，不能通过删除数据卷解决。

如服务器 Compose 不支持 --wait，需要先更新 Compose 插件，或使用 `up -d --no-build app` 后明确等待容器健康并执行上面的检查。容器内监听 8787，生产前端和 API 由同一服务提供，不使用 5173 开发服务器。

## 五、在现有 Caddy 中接入域名

让 `image.yidianhub.com` 解析到现有服务器。备份现有配置：

```bash
sudo cp -a /opt/yidian-api/deploy/Caddyfile "/opt/yidian-api/deploy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)"
sudo nano /opt/yidian-api/deploy/Caddyfile
```

先确认没有重复图片域名，在原有站点块之外**追加**：

```caddyfile
image.yidianhub.com {
    encode zstd gzip
    request_body {
        max_size 21MB
    }
    reverse_proxy yidian-image-web:8787
}
```

保留其他域名块和全局配置。先验证，通过后再平滑加载：

```bash
sudo docker exec yidian-api-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

确认上条命令成功后：

```bash
sudo docker exec yidian-api-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -fsS https://image.yidianhub.com/api/health
```

应返回 `{"ok":true}`。HTTPS 证书由现有 Caddy 管理。容器间使用 `yidian-image-web:8787`，不要改为 Caddy 自己的 127.0.0.1。

## 六、全新管理员和模型

SMTP/HTTPS 正常后，临时开放注册：

```bash
sudo docker compose --env-file .env.production exec app node dist/scripts/admin.js registration true
```

在图片站完成邮箱验证码注册，然后：

```bash
sudo docker compose --env-file .env.production exec app node dist/scripts/admin.js promote "你的注册邮箱"
sudo docker compose --env-file .env.production exec app node dist/scripts/admin.js registration false
```

线上模型目录是新的，需要在后台验证/启用 GPT Image 2。已知试用配置：准确模型 ID `gpt-image-2`；标准质量映射 medium；方形 size=1024x1024；单张；三种任务每张 12 积分；尺寸说明注明实测输出1254×1254、以实际文件为准。

先用管理员模型测试验证服务器链路（真实调用会有费用），确认后启用。通过兑换码发放试用积分，支付仍关闭。统一使用服务器服务 Key，消费者无需另建 New API 账号。

## 七、升级与回退

发布新版本后只下载对应部署包，先备份数据库/图片以及当前 Compose、.env.production。将 `.env.production` 中的 YIDIAN_IMAGE 更新为新版本 release-manifest.json 的 digest 引用，然后：

```bash
sudo docker compose --env-file .env.production pull app
sudo docker compose --env-file .env.production up -d --no-build --wait --wait-timeout 120 app
```

只有配置文件变化时也应执行 up，使环境变量生效；单纯 restart 不会重新读取 env_file。数据卷和项目名保持不变。不要使用 `down -v`。

回退应用时将 YIDIAN_IMAGE 改回先前保存的 digest，再执行 pull/up。若新版本改变数据库结构，旧镜像不一定兼容，须依据版本说明评估是否恢复成对的数据库/媒体备份；不能认为换旧镜像总能无损回退。

## 验证范围

GitHub 上的绿色工作流才代表远程构建/容器检查通过。本地配置解析不代表镜像已发布。版本支持 amd64/arm64 构建，运行烟测在 amd64 runner 上执行，arm64 与实际服务器均需单独验收。发布不会自动登录服务器、修改 Caddy、DNS 或配置真实收款。
