# Run the local Minecraft agent

Run the agent from this checkout against a private vanilla Minecraft server.
It joins once, observes the world, gets one strategic goal from Codex-LB, asks
TypeSafe to choose one app-defined action, verifies that action, saves progress,
and disconnects. The process never loops into a survival run.

The package requires Node.js 22.9 or later. The selected Minecraft 1.21.8 server
requires Java 21. The package pins Mineflayer 4.39.0, Pathfinder 2.4.5, and the
OpenAI SDK 7.36.0.

## Install the project

Run:

~~~
npm install
npm test
~~~

The tests run without provider credentials or a Minecraft server.

## Set provider credentials

Set `CODEX_LB_API_KEY` in your shell or in an ignored `.env` file. The gateway
defaults to `http://192.168.2.28:2455/backend-api/codex` and the model defaults
to `gpt-6-luna`. Process environment values take precedence over `.env`.

Supply `TYPESAFE_API_KEY` through the existing local secure-storage workflow.
The app reads it from the process environment. Keep the TypeSafe and Codex-LB
credentials separate.

The app does not print or persist provider keys. Do not commit `.env`.

## Configure a private server

Download the <a href="https://www.minecraft.net/en-us/download/server">official Minecraft server jar</a>
for 1.21.8 into <code>runtime/server/</code>. Read the Minecraft EULA and set
<code>eula=true</code> in <code>runtime/server/eula.txt</code> yourself. The app
never accepts the EULA for you.

Set these values in `runtime/server/server.properties`:

~~~
server-ip=127.0.0.1
server-port=25565
online-mode=false
difficulty=normal
~~~

Start the server with Java 21:

~~~
cd runtime/server
java -Xms1G -Xmx2G -jar minecraft_server.1.21.8.jar nogui
~~~

The bridge uses offline authentication. Keep both the server and bot bound to
loopback. Never use offline authentication on a LAN or public server.

## Run the smoke checks

Run each check separately. The first two make one read-only provider request.
The Minecraft check joins, observes state, and disconnects without an action.
The agent check plans and runs at most one bounded action.

~~~
npm run smoke:codex-lb
npm run smoke:typesafe-jev
npm run smoke:minecraft
npm run smoke:agent
~~~

Run <code>npm start</code> to run the same one-cycle agent command.

## Progress and victory evidence

The app stores progress at <code>runtime/progress.json</code>. It writes a
checkpoint only after an action's fresh observation passes its postcondition.
The write uses a temporary file and an atomic rename. Invalid progress stops
the run without replacing the file.

Seed, death count, and retry count stay unknown until the runtime can measure
them reliably. The advancement status is cleared on each verified action and
confirmed again only from the current server-owned player file.

The advancement check reads the bot UUID's file under
<code>runtime/server/world/advancements/</code>. It reports victory only when
the file contains <code>minecraft:end/kill_dragon</code> with
<code>done: true</code>. A missing or invalid file does not produce a victory
claim.

## Local settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINECRAFT_HOST` | `127.0.0.1` | Local server address. Other hosts are rejected. |
| `MINECRAFT_PORT` | `25565` | Local server port. |
| `MINECRAFT_VERSION` | `1.21.8` | Server version used by Mineflayer. |
| `MINECRAFT_USERNAME` | `MinecraftAgent` | Offline bot name. |
| `RUNTIME_DIR` | `runtime` | Server files and verified progress. |
| `CODEX_LB_BASE_URL` | `http://192.168.2.28:2455/backend-api/codex` | Codex-LB Responses endpoint. |
| `CODEX_LB_MODEL` | `gpt-6-luna` | Planner model. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` | TypeSafe choice endpoint. |
| `TYPESAFE_MODEL` | `jev-latest` | TypeSafe model alias. |

Runtime data, worlds, progress, logs, `.env`, and installed dependencies stay
out of Git.

## What the first slice proves

The agent checks each chosen action against a fresh observation before saving
progress. Its models select only from application-defined actions. This slice
does not implement survival progression or claim a dragon victory.

## Verification recorded on 2026-10-17

<code>npm test</code> passed all 56 offline tests. The tests do not need
provider credentials or a Minecraft server.

The Codex-LB preflight sent a request to
<code>http://192.168.2.28:2455/backend-api/codex</code>, but the SDK returned a
<code>TypeError</code> without an HTTP status. Treat provider access as
unverified.

The published <a href="https://api.typesafe.ai/openapi.json">TypeSafe OpenAPI
document</a> documents <code>POST /v1/systemone</code> and shows the
<code>jev-latest</code> alias. This checkout has no
<code>TYPESAFE_API_KEY</code>, so it did not test account access or model
availability. The TypeSafe and full-agent smoke checks stopped before a
provider request; the full-agent check also stopped before connecting to
Minecraft.

The Minecraft smoke command failed to connect. Java 21 is not installed in
this checkout, and no manually configured server or accepted EULA is present.
The advancement parser passed fixture tests, but this run did not verify the
1.21.8 server's saved file layout or flush timing.
