# Prism Live Viewer and Decision Distribution Design

**Status:** Approved in chat for implementation.

## Goal

Update Prism Agent Live so Wayne can watch the actual Prism 1.21.8 client with its complete visible HUD and see every action JEVi considered, the probability for each offered action, and the selected action highlighted as the decision arrives. Cap capture and display polling at 30 frames per second; lower measured rates are acceptable and must be reported accurately.

## Current behavior

- The Fabric bridge captures from `WorldRenderEvents.END` at most every 500 ms. The capture is before the HUD layer, so the panel omits the hotbar and status bars.
- The Node bridge polls the Prism HTTP endpoint every 500 ms. The panel receives state with SSE and fetches one JPEG per changed frame.
- JEVi receives application-owned action candidates and returns a selected ID. Its adapter currently discards provider score fields. The local provider fixture includes a `probabilities` map, but this is not yet validated as a live response contract.
- The supported action catalog is `wait_20_ticks`, `look_at_observed_block`, and `move_near_observed_position`. Candidate availability depends on the current observation.

## Approved design

### Prism POV and frame rate

Capture the completed Prism client frame after HUD rendering so the image includes the first-person view and the HUD elements Minecraft currently displays, including hotbar, health, hunger, armor, crosshair, and status effects where applicable. Continue using the already-open Prism client; do not add a second game connection.

On first connection, allow the client a brief startup window to present its initial Game Menu before dismissing it once. Do not keep dismissing menus after startup, so the player can still pause the game later.

Raise the local capture and bridge polling cadence to a 30 fps cap. Keep only the newest frame at each boundary and drop intermediate frames if capture, JPEG encoding, transfer, or browser rendering falls behind. Do not queue frames or replay stale images. Measure unique frame updates delivered to the panel over a rolling one-second interval and display the measured fps. Lower rates are acceptable; the UI must show the measured rate.

Keep screenshots on loopback. Preserve the current JPEG frame size and quality unless live performance evidence requires reducing them. Keep agent decisions on the existing SSE state channel; when a new frame revision arrives, the page fetches that version from the existing local `/frame.jpg` endpoint. Do not add a remote service, another transport dependency, or direct browser access to the Prism bridge.

### JEVi choices and probabilities

Show the full supported action catalog and mark each action as offered or unavailable in the current decision. For every offered action, show the provider-returned probability as a percentage. Highlight the selected action as soon as JEVi's response is accepted.

Accept a probability distribution only when it has exactly one value for each offered ID, no other IDs, every value is finite and between 0 and 1, and the values sum to 1 within a small rounding tolerance. Convert a valid distribution to percentages totaling 100%. If the field is missing or invalid, label scores unavailable; never infer unreturned scores from the selected ID or scalar confidence. Continue validating the selected ID against the offered actions before any action can execute. Scores affect display only and cannot alter execution.

Preserve the existing Codex goal, event trace, execution state, independent verification, and checkpoint display. Do not expose hidden model reasoning or send POV frames to Codex-LB or JEVi.

## Data flow

1. The Prism client captures a post-HUD frame at the render boundary, capped at 30 fps.
2. A latest-frame buffer replaces older frames; slow consumers cause drops, not a growing queue.
3. The Node process polls the loopback Prism bridge at the target cadence and publishes each newest unique frame revision through the existing SSE state. The page fetches that revision from the existing versioned JPEG endpoint.
4. The agent passes JEVi's returned probability map through the provider boundary only after validating its IDs and values. The panel joins scores to the offered action IDs and highlights the validated selected ID.

## Synthesis decision

The reviewed candidates were a persistent WebSocket bridge and loopback HTTP polling with the existing SSE panel channel. The approved design keeps the bridge on the existing HTTP endpoints and sends only changed frame revisions to the page over SSE. This reuses the current bridge, preserves latest-frame polling, and avoids a second transport protocol and its connection lifecycle. The HTTP poll cadence is capped at 30 fps, and the measured page rate reports capture, transfer, and rendering limits.

The frame is one atomic `{ revision, jpeg }` value. The decision shown by the panel is `{ selectedId, probabilities }`, where `probabilities` is either a validated map for exactly the offered action IDs or `null`. The selected ID keeps its existing validation and execution path.

## Failure behavior

- If Prism renders below 30 fps, display the measured lower rate.
- If frame encoding or transfer falls behind, drop frames and continue with the newest frame; do not delay gameplay or action verification to drain a queue.
- If the client disconnects, mark the POV stale or disconnected rather than presenting the last frame as live.
- If JEVi omits scores or returns an invalid map, keep the selected action and decision trace visible while marking percentages unavailable. An invalid action ID still stops before execution.

## Acceptance criteria

1. The panel displays a live image captured from the actual Prism client, including its visible HUD elements.
2. A measured frame-rate indicator reflects unique frames received by the panel. The stream is capped at 30 fps; under load it drops frames and reports the lower rate.
3. The panel lists every supported action, shows which actions were offered for the current observation, and displays valid per-choice probabilities for all offered actions.
4. The selected action is highlighted when JEVi's response arrives. Missing or invalid scores are visibly unavailable and never fabricated.
5. The existing bounded action validation and execution path remains authoritative; probabilities are display data only.
6. POV frames remain local and hidden model reasoning remains private.

## Out of scope

- Adding gameplay actions, changing the goal/action policy, or running a continuous gameplay loop.
- Historical action-frequency charts, scalar-confidence substitution, or fabricated percentages.
- Sending screenshots to a model, adding remote access, or opening the Minecraft bridge beyond loopback.
- Guaranteeing 30 fps when the game, browser, display, or host cannot render at that rate.
