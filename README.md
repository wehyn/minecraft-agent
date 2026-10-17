# Control the Prism Minecraft client with Codex and JEVi

This app controls the player already running in Prism Launcher. A small Fabric
client mod reads the live world and framebuffer, then accepts only the three
bounded action IDs defined by this app. It never starts a second Minecraft
connection or closes Prism.

The first run performs one cycle: Codex returns a validated goal, JEVi selects
from the exact app-owned choices, the Prism player performs the selected action,
and Node verifies the result from a fresh observation. A local panel shows the
current POV and each validated step.

## Install the Prism bridge

Use the vanilla 1.21.8 Prism instance. Install Fabric Loader 0.19.5 and Fabric
API 0.136.1+1.21.8 for Minecraft 1.21.8. Do not add these files to the
Fabulously Optimized instance.

Build the mod:

~~~
cd fabric-client
./gradlew build
~~~

Copy
<code>fabric-client/build/libs/prism-agent-bridge-0.1.0.jar</code> into the
1.21.8 instance's <code>minecraft/mods/</code> folder. Create
<code>minecraft/config/minecraft-agent-bridge.json</code> with this shape:

~~~
{"token":"64 hexadecimal characters"}
~~~

The token must match <code>PRISM_BRIDGE_TOKEN</code> in the project's ignored
<code>.env</code> file. The mod binds only to
<code>127.0.0.1:8766</code>. Keep the token out of screenshots, provider
requests, and the panel URL.

## Configure and run

Set <code>CODEX_LB_API_KEY</code>, <code>TYPESAFE_API_KEY</code>, and
<code>PRISM_BRIDGE_TOKEN</code> in <code>.env</code>. The Codex gateway defaults
to <code>http://192.168.2.28:2455/backend-api/codex</code> and model
<code>gpt-6-luna</code>. TypeSafe defaults to
<code>https://api.typesafe.ai/v1/systemone</code> and model
<code>jev-latest</code>.

Start the local 1.21.8 server if needed, launch the Prism 1.21.8 instance, and
join the intended world. Then run:

~~~
npm install
npm start
~~~

The app prints the local panel URL, normally
<code>http://127.0.0.1:8765/</code>. It waits for the authenticated Prism
client, then runs exactly one action cycle. The panel Stop button cancels the
action, releases bridge-owned keys, and closes the local controller. Prism stays
open. Press Ctrl-C for the same cleanup.

Use <code>npm run smoke:minecraft</code> to attach read-only to the already-open
Prism player and print a small state summary. It does not create a Minecraft
player.

## Live panel and provider boundary

The panel receives the validated Codex goal, the exact choices sent to JEVi,
JEVi's selected action ID, execution status, verifier evidence, and checkpoint
result. It does not display hidden model reasoning or invent a rationale.
Screenshots remain in memory and on loopback; they are not sent to providers or
saved to disk. The panel has no authentication, so programs on the same computer
can read its event stream and live frame.

Codex and JEVi receive structured game observations and the bounded goal/action
choices needed for their requests. They do not receive the screenshot. JEVi
cannot choose coordinates or send executable code.

## Progress and verification

Progress is stored at <code>runtime/progress.json</code>. A checkpoint is saved
only after a fresh Prism observation passes the action's independent
postcondition. The advancement check reads
<code>runtime/server/world/advancements/</code> using the UUID reported by the
connected Prism player. If the local server uses a different world directory or
player identity, victory remains unknown.

The bridge accepts only <code>wait_20_ticks</code>,
<code>look_at_observed_block</code>, and
<code>move_near_observed_position</code>. It does not break/place blocks, jump,
sprint, chat, manipulate inventory, or accept model-authored parameters.
Movement is short, rechecks a clear supported path, stops for manual input, and
releases its forward key on every terminal path. The mod enforces its own action
deadline if the Node process disappears.

## Local settings

| Variable | Default | Purpose |
| --- | --- | --- |
| <code>PRISM_BRIDGE_TOKEN</code> | required | Shared 64-character local pairing token. |
| <code>PANEL_PORT</code> | <code>8765</code> | Loopback decision panel port. |
| <code>RUNTIME_DIR</code> | <code>runtime</code> | World files and verified progress. |
| <code>CODEX_LB_BASE_URL</code> | <code>http://192.168.2.28:2455/backend-api/codex</code> | Codex-LB Responses endpoint. |
| <code>CODEX_LB_MODEL</code> | <code>gpt-6-luna</code> | Planner model. |
| <code>TYPESAFE_BASE_URL</code> | <code>https://api.typesafe.ai/v1/systemone</code> | TypeSafe choice endpoint. |
| <code>TYPESAFE_MODEL</code> | <code>jev-latest</code> | TypeSafe model alias. |
