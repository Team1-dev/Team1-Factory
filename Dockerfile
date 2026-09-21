FROM node:22-bookworm-slim

# build-essential, procps and file are what Homebrew asks of the machine under it.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git jq curl ca-certificates build-essential procps file \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable

# Claude Code refuses to run unattended as root, so everything from here on is an ordinary user.
# The directories are made now so the volumes mounted over them start out owned by that user.
RUN useradd --create-home --shell /bin/bash team1 \
	&& install -d -o team1 -g team1 /home/team1/.claude /home/team1/.team1 /home/linuxbrew /home/linuxbrew/.linuxbrew

USER team1
# Homebrew comes last: what it installs is found, and nothing it installs can stand in for the node Team1 itself runs on.
ENV PATH=/home/team1/.local/bin:$PATH:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin
RUN curl -fsSL https://claude.ai/install.sh | bash

# Homebrew is how the agent installs a compiler or a runtime a repo's gates need and the image lacks, without root.
# Cloned into its default prefix, which is the one its prebuilt packages are built for.
RUN git clone https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew \
	&& mkdir /home/linuxbrew/.linuxbrew/bin \
	&& ln -s ../Homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew \
	&& brew analytics off \
	&& brew --version

# Team1 has no runtime dependencies, so there is nothing to npm install. The app is root's and read-only to team1:
# a model running with permission checks off cannot rewrite the factory that runs it.
USER root
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY stages ./stages
COPY scripts ./scripts
USER team1

CMD ["node", "src/poll.mjs"]
