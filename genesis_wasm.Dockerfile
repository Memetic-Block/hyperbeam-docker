FROM ubuntu:22.04 AS build

## Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    pkg-config \
    ncurses-dev \
    libssl-dev \
    sudo \
    python3 \
    curl \
    openssl

## Install erlang from source
RUN git clone https://github.com/erlang/otp.git && \
    cd otp && \
    git checkout maint-27 && \
    ./configure && \
    make -j16 && \
    sudo make install

## Install rebar3 from source
RUN git clone https://github.com/erlang/rebar3.git && \
    cd rebar3 && \
    ./bootstrap && \
    sudo mv rebar3 /usr/local/bin/

## Install rust from source
# RUN git clone https://github.com/rust-lang/rust.git && \
#     cd rust && \
#     ./configure && \
#     make && \
#     sudo make install

## Install rust from rustup (faster, recommended)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    --default-toolchain 1.95 -y
ENV PATH="/root/.cargo/bin:${PATH}"

## Install Node.js with nvm
ARG NODE_VERSION='22.18.0'
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && \
    \. "$HOME/.nvm/nvm.sh" && \
    export NVM_DIR="$HOME/.nvm" && \
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && \
    nvm install $NODE_VERSION && \
    nvm use $NODE_VERSION && \
    nvm alias default $NODE_VERSION
ENV NVM_DIR="/root/.nvm"
ENV PATH="$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH"

WORKDIR /app
ARG VERSION='edge'
RUN git clone https://github.com/permaweb/hyperbeam.git --depth 1 . && \
    git checkout $VERSION
RUN rebar3 compile

CMD [ "rebar3", "as", "genesis_wasm", "shell" ]

FROM build AS release
COPY --from=build /app /app
COPY config.flat /app/config.flat
RUN rebar3 as genesis_wasm release
WORKDIR /app/_build/genesis_wasm/rel/hb/

CMD [ "./bin/hb", "foreground" ]
