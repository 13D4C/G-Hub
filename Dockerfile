FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

# ffmpeg and ffprobe for the transcode worker (src/server/plugins/transcode.ts).
#
# Installed into this stage rather than copied from `build`: this stage deliberately takes
# only `.output`, and ffmpeg is a system binary rather than a build artifact. Alpine's
# `ffmpeg` package carries both binaries and libx264.
#
# Kept above the COPY on purpose. It is the largest layer in the image by some margin, and
# above the COPY it is cached across deploys, so a redeploy only ships the app layer.
RUN apk add --no-cache ffmpeg

COPY --from=build /app/.output ./.output

EXPOSE 3000
# Three seconds was enough before this container also encoded video. Under a transcode the
# CPU is saturated and a tight timeout fails the check, which restarts the container — which
# kills the encode, which starts again on the next claim. The lease and the attempt cap stop
# that becoming permanent, but the loop is better not started.
HEALTHCHECK --interval=30s --timeout=10s CMD wget -qO- http://localhost:3000/ >/dev/null || exit 1

CMD ["node", ".output/server/index.mjs"]
