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

## Install rust from rustup (faster, recommended)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    --default-toolchain 1.95 -y
ENV PATH="/root/.cargo/bin:${PATH}"

## Build HyperBEAM with the default rebar3 profile: AO mainnet with the lua
## device (~lua@5.3a) as the compute method. Legacy ao.TN.1 (genesis_wasm)
## processes are NOT supported by this image — see legacy/ for that.
WORKDIR /app
ARG VERSION='v0.9-FINAL'
RUN git init . && \
    git remote add origin https://github.com/permaweb/hyperbeam.git && \
    git fetch --depth 1 origin $VERSION && \
    git checkout FETCH_HEAD
RUN rebar3 compile

CMD [ "rebar3", "shell" ]

FROM build AS release
COPY config.flat /app/config.flat
RUN rebar3 release
WORKDIR /app/_build/default/rel/hb/

CMD [ "./bin/hb", "foreground" ]
