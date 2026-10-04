# Node 24 for native TypeScript stripping - no build step, no bundler, and
# nothing to go stale between the source and what runs.
FROM node:24-alpine

# ffmpeg is the one real dependency, and it is a binary rather than a package
# so `npm install` stays empty. It is needed to inspect GIFs (frame counts
# drive whether Protect will accept them) and to reduce the ones that will
# not fit.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# No dependencies, so no install step and no layer caching to arrange.
COPY package.json ./
COPY src ./src

# Media and the database are mounted, never baked in. The media library is
# the irreplaceable half.
VOLUME ["/data", "/media"]
ENV DOORMAN_DB=/data/doorman.sqlite \
    DOORMAN_MEDIA=/media

# node:sqlite prints an ExperimentalWarning on every start. It is noise, and
# suppressing it stops people reporting it as an error.
ENV NODE_OPTIONS=--no-warnings

CMD ["node", "src/cli/serve.ts"]
