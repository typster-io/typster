FROM elixir:1.20-alpine AS builder

ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN apk add --no-cache build-base git curl unzip bash
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /app

RUN mix local.hex --force && \
    mix local.rebar --force

ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && \
    mix deps.compile

# Copy config before assets (needed for asset building)
COPY config ./config

# Copy lib before assets (needed for phoenix-colocated components)
COPY lib ./lib
COPY priv ./priv

RUN mix compile

COPY assets/package.json assets/bun.lock ./assets/
RUN cd assets && bun install

COPY assets ./assets

RUN mix assets.deploy
RUN mix release

FROM alpine:3.24.2 AS runner

RUN apk add --no-cache \
    openssl \
    ncurses-libs \
    libstdc++ \
    ca-certificates

WORKDIR /app

RUN chown nobody:nobody /app

COPY --from=builder --chown=nobody:nobody /app/_build/prod/rel/typster ./

USER nobody:nobody

ENV PHX_SERVER=true
ENV MIX_ENV=prod

EXPOSE 4000

CMD ["/app/bin/typster", "start"]
