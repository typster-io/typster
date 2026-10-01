FROM elixir:1.20

RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    inotify-tools \
    postgresql-client \
    zsh \
    unzip \
    && rm -rf /var/lib/apt/lists/*


# Add Bun
RUN curl -fsSL https://bun.sh/install | bash

ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Build elixir app

RUN mix local.hex --force && \
    mix local.rebar --force

RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended || true

RUN echo 'export PATH="$HOME/.mix/escripts:$PATH"' >> /root/.zshrc && \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> /root/.zshrc && \
    chsh -s /bin/zsh root || true

WORKDIR /workspace
