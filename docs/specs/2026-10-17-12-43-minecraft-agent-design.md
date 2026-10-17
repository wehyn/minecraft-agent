# Minecraft Agent Design Spec

## Problem Statement

The user wants GPT-6 Luna to make strategic progress in a real Minecraft Java world and wants TypeSafe JEV to choose bounded in-game actions. The current workspace has no Minecraft project or implementation. Existing examples show that LLMs can drive Mineflayer, but their reported runs do not establish a repeatable win on an ordinary world. Broad code-generation approaches also give models more control than this project needs.

## Solution

Create a local Node.js agent that connects through Mineflayer to a private vanilla Minecraft Java server. The server and bot bridge run on the Mac. The bridge sends strategic planning requests to the existing Codex-LB service on the always-on Dell, then sends current state and a code-created list of allowed action IDs to TypeSafe JEV. JEV selects one candidate; application code validates it, executes it, observes the world again, verifies the postcondition, and saves progress.

Begin with a read-only join and observation check, then prove the JEV selection-to-execution boundary with harmless actions. Add bounded Pathfinder movement, then Luna planning. Treat the server's “Free the End” advancement for the bot identity as the victory condition. A successful integration check is not a claim that a full dragon run will succeed.

## User Stories

1. As the project owner, I want to start a private vanilla Java server and the agent locally, so that experiments do not affect public servers or existing Minecraft worlds.
2. As the project owner, I want the server version and Java runtime pinned and recorded, so that a run can be reproduced and protocol compatibility can be diagnosed.
3. As the agent, I want to connect through Mineflayer and wait for spawn and nearby chunks, so that I can observe a valid initial game state before acting.
4. As the project owner, I want the first milestone to report position, dimension, health, difficulty, inventory, and nearby blocks without changing the world, so that connection and observation are proven independently of model actions.
5. As the agent, I want Luna to receive a concise current state and strategic objective through Codex-LB, so that it can suggest the next goal without issuing game commands.
6. As the project owner, I want Codex-LB calls to use the configured Responses API endpoint on the Dell and the `gpt-6-luna` model, so that planner traffic uses the existing provider service.
7. As the project owner, I want the Codex-LB API key read at runtime from `CODEX_LB_API_KEY`, so that credentials are not placed in source code, prompts, or committed configuration.
8. As the project owner, I want an ignored local `.env` fallback only when the running project process cannot inherit `CODEX_LB_API_KEY`, so that local setup can work without committing the secret.
9. As the agent, I want application code to generate a small list of valid actions based on state and the current goal, so that JEV cannot invent action names, coordinates, or executable code.
10. As the agent, I want TypeSafe JEV to select one offered action ID, so that action selection stays separate from action implementation.
11. As the project owner, I want the bridge to reject any JEV result that is absent from the offered list or fails validation, so that malformed or stale provider output cannot trigger an action.
12. As the agent, I want each action to have a hard execution bound and an explicit postcondition, so that long or uncertain actions stop safely and can be checked against new observations.
13. As the project owner, I want provider timeouts, disconnects, invalid choices, and uncertain game state to stop the loop without acting, so that a failure does not silently become an unsafe action.
14. As the agent, I want to use Pathfinder for short movement goals after the basic action loop works, so that navigation can improve without exposing unrestricted movement or block modification.
15. As the project owner, I want movement settings to prevent block breaking and placement unless a later action explicitly permits them, so that navigation does not unexpectedly alter terrain.
16. As the project owner, I want progress checkpoints to record verified goals, action outcomes, and run conditions without credentials, so that interrupted sessions can resume and results can be audited.
17. As the project owner, I want separate credentials for Codex-LB and TypeSafe JEV, so that one provider's key is never reused or sent to the other provider.
18. As the project owner, I want the agent to stop cleanly on user request or process interruption, so that provider calls and in-progress movement do not continue after shutdown.
19. As the project owner, I want victory to require the bot's “Free the End” advancement to be recorded by the server, so that dragon-related logs or model judgments alone cannot claim completion.
20. As the project owner, I want each long run to record Minecraft version, seed, difficulty, elapsed time, deaths, and retries, so that a reported result is not confused with a special-seed demo or a success-rate guarantee.

## Implementation Decisions

### Runtime and provider boundaries

- Use Node.js with Mineflayer and Mineflayer Pathfinder. Keep the Minecraft server vanilla; do not require server-side mods or plugins.
- Run the private Minecraft server and bot bridge on the Mac. Bind the initial server to loopback unless a later requirement explicitly needs LAN access.
- Use the existing Codex-LB service on the Dell for Luna planning. The supplied client profile is named `openai`, uses `http://192.168.2.28:2455/backend-api/codex`, and speaks the Responses API (`wire_api = "responses"`). Request `gpt-6-luna` with max reasoning and the Standard service tier where the gateway supports those options. The existing configuration advertises WebSocket support; use it only if the client requires it.
- Resolve the Codex-LB credential from `CODEX_LB_API_KEY` at runtime. `env_key` identifies the variable; it is not the credential value. If the project process cannot inherit the variable, support a local `.env` fallback and keep the file ignored by Git. Do not create or commit a populated `.env` file.
- Use TypeSafe JEV as a separate provider for bounded choice requests. Keep its API credential separate from Codex-LB and in local secure storage. Use the currently documented TypeSafe API and verify the supported model and endpoint for the account; do not copy the older `/api/alpha/decisions` route from the community example without verification.
- Luna proposes goals and milestones only. Application code constructs the action candidates. JEV returns one offered candidate ID. The bridge validates that ID, maps it to a fixed application-owned action, executes it, reobserves the game, and verifies the action's postcondition. Neither provider returns executable Mineflayer code.

### Game state, actions, and progress

- Start with a read-only observation containing player position, dimension, health, food, inventory summary, current difficulty, and nearby relevant blocks. Bound observation size and omit unrelated chat or secrets.
- The first JEV candidates should be harmless, such as looking at an observed block or waiting a fixed number of ticks. Add short movement only after this loop works. Do not offer arbitrary coordinates, unrestricted `goto`, digging, placing, attacking, or inventory disposal in the initial action set.
- Every candidate has application-owned parameters, a timeout, and a verifiable postcondition. Reobserve after execution. On invalid output, timeout, disconnect, or ambiguous postcondition, stop and report the state instead of retrying a potentially mutating action blindly.
- Persist only local progress needed to resume and audit: run identity and conditions, current goal, verified milestone state, and bounded action outcomes. Keep Minecraft world data and credentials out of Git. Write a checkpoint only after a postcondition is verified.
- Victory requires server-side evidence that the correct bot identity received “Free the End.” Confirm the exact verification mechanism against the pinned Minecraft server version before relying on it.

### Milestones

1. Confirm Mac-to-Dell Codex-LB reachability and a successful Luna Responses request; confirm TypeSafe JEV access separately. Do not print credentials.
2. Start a pinned, compatible vanilla server and connect Mineflayer; report state and disconnect without an in-game change.
3. Offer harmless JEV candidates, validate one returned ID, execute once, and verify the result.
4. Add bounded Pathfinder movement with block modification disabled and verify position after each movement.
5. Add Luna strategic goals while retaining JEV as the action selector and application code as the executor.
6. Run longer survival sessions, save verified progress, and evaluate victory only from the server's advancement state.

## Testing Decisions

- Test the external behavior at the agent-loop seam: a game observation and goal result produce a bounded candidate list; a valid JEV choice results in exactly one corresponding action; a fresh observation determines whether the postcondition passed; verified progress is then saved.
- Use provider fakes for ordinary tests. Cover valid choice, unknown choice, provider timeout/error, action timeout, disconnect, failed postcondition, and resume from a verified checkpoint. Assert that invalid or uncertain outcomes execute no additional action.
- Add one opt-in integration check against the pinned private vanilla server that proves Mineflayer can join, observe state, and disconnect. Add a separate harmless JEV live check and Codex-LB live request; never make tests depend on a full dragon run.
- The integration acceptance test for victory must inspect server-owned advancement state for the bot identity. Do not use a model's self-assessment as proof.
- Prior art: the community Minecraft agent separates JEV choices from application actions; Mineflayer and Pathfinder document the client and movement APIs; TypeSafe's OpenAPI schema documents its choice contract. Voyager and Mindcraft show code-generation alternatives but are not the selected safety boundary.

## Out of Scope

- Building a GUI, dashboard, or remote multiplayer service.
- Exposing the Minecraft server or Codex-LB endpoint to the public Internet.
- Letting Luna or JEV write and execute arbitrary Mineflayer code.
- Using mods, datapacks, commands, cheats, preloaded supplies, or a specially prepared End portal to claim a random-world survival win.
- Guaranteeing a dragon victory, a completion time, or a success rate.
- Transferring credentials between providers or committing live credentials.
- Starting a full dragon run before the connection, bounded-action, and verification milestones pass.

## Further Notes

- The referenced `rmalde/minecraft-agent` is useful implementation prior art. Its README reports an 8:43 run on Java 1.16.5, Peaceful difficulty, and a specially selected seed with supplies and an active End portal; run artifacts are not committed, so the report is not independently verifiable from the repository.
- The user-provided paper at https://arxiv.org/html/2610.22319 reports a four-agent dragon win on a random Easy world after 27h14m with 605 deaths. Treat that as one reported run, not a success-rate estimate.
- Codex-LB must be reached over a private route from the Mac. A successful model-list response alone is not sufficient; test an actual Luna request through the configured endpoint.
- The current shell process had `CODEX_LB_API_KEY` set when this design was prepared. This confirms presence only, not key validity or inheritance by a future project process.
- Research references: [Minecraft agent](https://github.com/rmalde/minecraft-agent), [Voyager paper](https://arxiv.org/abs/2305.16291), [Voyager implementation](https://github.com/MineDojo/Voyager), [Mindcraft](https://github.com/mindcraft-bots/mindcraft), [Mineflayer](https://github.com/PrismarineJS/mineflayer), [Mineflayer Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), [TypeSafe API](https://api.typesafe.ai/redoc), [Codex app-server docs](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), and [GPT-6 Luna docs](https://developers.openai.com/api/docs/models/gpt-6-luna).
