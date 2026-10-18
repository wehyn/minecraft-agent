package dev.wayne.minecraftagent;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.GameMenuScreen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.multiplayer.ConnectScreen;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.InputUtil;
import net.minecraft.client.network.ServerAddress;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.world.Difficulty;
import net.minecraft.world.RaycastContext;
import net.minecraft.world.World;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class PrismBridgeClient implements ClientModInitializer {
    private record CapturedFrame(long revision, byte[] jpeg) {}

    private static volatile PrismBridgeClient instance;
    private static final int PORT = 8766;
    private static final int MAX_BODY_BYTES = 16_384;
    private static final int MAX_FRAME_BYTES = 350_000;
    private static final double MAX_MINING_REACH = 4.5;
    private static final Set<String> ACTION_IDS = Set.of(
            "resume_game",
            "wait_20_ticks",
            "look_at_observed_block",
            "move_near_observed_position",
            "mine_observed_log",
            "craft_planks_from_logs",
            "craft_sticks_from_planks",
            "craft_table_from_planks"
    );
    private static final Set<String> WOOD_TYPES = Set.of(
            "acacia", "birch", "cherry", "crimson", "dark_oak", "jungle",
            "mangrove", "oak", "pale_oak", "spruce", "warped"
    );
    private static final Set<String> HAZARDS = Set.of(
            "cactus", "campfire", "fire", "lava", "magma_block",
            "powder_snow", "pointed_dripstone", "soul_campfire",
            "soul_fire", "sweet_berry_bush", "water", "bubble_column"
    );

    private final AtomicReference<ActionCommand> pendingAction = new AtomicReference<>();
    private final AtomicReference<CapturedFrame> latestFrame = new AtomicReference<>();
    private final AtomicBoolean frameBusy = new AtomicBoolean();
    private final ExecutorService frameEncoder = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "prism-frame-encoder");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicReference<String> cancelRequested = new AtomicReference<>();
    private final ConcurrentHashMap<String, JsonObject> receipts = new ConcurrentHashMap<>();
    private final ObservationState observations = new ObservationState();
    private volatile String token;
    private boolean autoConnectLocalServer;
    private boolean joinAttempted;
    private boolean gameMenuLogged;
    private volatile String playerUuid;
    private volatile ActiveAction activeAction;
    private boolean ownsForwardKey;
    private HttpServer server;
    private long tickCounter;
    private long frameRevision;
    private long lastFrameNanos;

    @Override
    public void onInitializeClient() {
        loadToken();
        if (token == null) return;
        try {
            startServer();
        } catch (IOException error) {
            System.err.println("[Prism Agent Bridge] Could not bind 127.0.0.1:" + PORT);
            return;
        }
        instance = this;
        ClientTickEvents.END_CLIENT_TICK.register(this::tick);
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            instance = null;
            ActionCommand queued = pendingAction.getAndSet(null);
            if (queued != null) finishQueued(queued, "cancelled", null);
            if (activeAction != null) finishAction("cancelled", null);
            releaseControls(client);
            frameEncoder.shutdown();
            stopServer();
        });
        System.out.println("[Prism Agent Bridge] Listening on 127.0.0.1:" + PORT);
    }

    private void loadToken() {
        Path config = FabricLoader.getInstance().getConfigDir().resolve("minecraft-agent-bridge.json");
        try {
            if (!Files.isRegularFile(config)) {
                System.err.println("[Prism Agent Bridge] Missing config/minecraft-agent-bridge.json");
                return;
            }
            JsonObject value = JsonParser.parseString(Files.readString(config)).getAsJsonObject();
            String supplied = value.get("token").getAsString();
            if (!supplied.matches("(?i)[a-f0-9]{64}")) {
                System.err.println("[Prism Agent Bridge] Invalid local bridge token");
                return;
            }
            token = supplied;
            JsonElement autoConnect = value.get("autoConnectLocalServer");
            autoConnectLocalServer = autoConnect != null
                    && autoConnect.isJsonPrimitive()
                    && autoConnect.getAsBoolean();
        } catch (Exception error) {
            System.err.println("[Prism Agent Bridge] Could not read local bridge config");
        }
    }

    private void startServer() throws IOException {
        server = HttpServer.create(
                new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 0);
        server.createContext("/", this::handleRequest);
        server.setExecutor(Executors.newFixedThreadPool(2, runnable -> {
            Thread thread = new Thread(runnable, "prism-agent-bridge-http");
            thread.setDaemon(true);
            return thread;
        }));
        server.start();
    }

    private void stopServer() {
        if (server != null) server.stop(0);
    }

    public static void captureCompletedRender() {
        PrismBridgeClient bridge = instance;
        if (bridge != null) bridge.captureFrame();
    }

    private void handleRequest(HttpExchange exchange) throws IOException {
        try {
            if (!exchange.getRemoteAddress().getAddress().isLoopbackAddress()
                    || !authorized(exchange)) {
                send(exchange, 401, error("unauthorized"));
                return;
            }

            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if (path.equals("/v1/session") && method.equals("GET")) {
                send(exchange, 200, session());
            } else if (path.equals("/v1/snapshot") && method.equals("GET")) {
                JsonObject snapshot = snapshot(
                        exchange.getRequestHeaders().getFirst("X-After-Frame-Revision"));
                if (snapshot == null) send(exchange, 503, error("not_ready"));
                else send(exchange, 200, snapshot);
            } else if (path.equals("/v1/action") && method.equals("POST")) {
                submitAction(exchange);
            } else if (path.startsWith("/v1/action/")) {
                actionStatus(exchange, path, method);
            } else {
                send(exchange, 404, error("not_found"));
            }
        } catch (BodyTooLarge error) {
            send(exchange, 413, error("body_too_large"));
        } catch (Exception error) {
            send(exchange, 400, error("invalid_request"));
        } finally {
            exchange.close();
        }
    }

    private boolean authorized(HttpExchange exchange) {
        String supplied = exchange.getRequestHeaders().getFirst("Authorization");
        if (supplied == null) return false;
        byte[] expected = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
        byte[] actual = supplied.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expected, actual);
    }

    private JsonObject session() {
        JsonObject value = new JsonObject();
        value.addProperty("protocolVersion", 1);
        value.addProperty("minecraftVersion", "1.21.8");
        value.addProperty("connected", observations.current().observation() != null && playerUuid != null);
        if (playerUuid != null) value.addProperty("playerUuid", playerUuid);
        JsonArray ids = new JsonArray();
        ACTION_IDS.forEach(ids::add);
        value.add("actionIds", ids);
        return value;
    }

    private JsonObject snapshot(String afterFrameRevision) {
        JsonObject value = observations.snapshotJson();
        CapturedFrame frame = latestFrame.get();
        if (!value.has("observation") || frame == null || frame.jpeg().length < 4) return null;
        value.addProperty("frameRevision", frame.revision());
        value.addProperty("capturedAt", java.time.Instant.now().toString());
        if (!Long.toString(frame.revision()).equals(afterFrameRevision)) {
            value.addProperty("frame", Base64.getEncoder().encodeToString(frame.jpeg()));
        }
        return value;
    }

    private void submitAction(HttpExchange exchange) throws IOException {
        JsonObject body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        String commandId = string(body, "commandId");
        long basedOnSequence = integer(body, "basedOnSequence");
        JsonObject action = body.getAsJsonObject("action");
        if (action == null || !isUuid(commandId)) {
            send(exchange, 400, error("invalid_action"));
            return;
        }
        JsonObject existing = receipts.get(commandId);
        if (existing != null) {
            send(exchange, 200, existing.deepCopy());
            return;
        }

        ObservationState.Snapshot current = observations.current();
        long currentSequence = current.sequence();
        if (current.observation() == null || currentSequence - basedOnSequence < 0
                || currentSequence - basedOnSequence > 2) {
            send(exchange, 409, error("stale_observation"));
            return;
        }
        if (pendingAction.get() != null || activeAction != null) {
            send(exchange, 409, error("busy"));
            return;
        }
        ActionCommand command = new ActionCommand(commandId, basedOnSequence, action.deepCopy());
        JsonObject receipt = receipt(commandId, "accepted", null, false);
        receipts.put(commandId, receipt);
        if (!pendingAction.compareAndSet(null, command)) {
            receipts.remove(commandId, receipt);
            send(exchange, 409, error("busy"));
            return;
        }
        pruneReceipts();
        send(exchange, 202, receipt.deepCopy());
    }

    private void actionStatus(HttpExchange exchange, String path, String method) throws IOException {
        String[] parts = path.split("/");
        if (parts.length != 4 && parts.length != 5) {
            send(exchange, 404, error("not_found"));
            return;
        }
        String commandId = parts[3];
        if (!isUuid(commandId)) {
            send(exchange, 404, error("not_found"));
            return;
        }
        if (parts.length == 4 && method.equals("GET")) {
            JsonObject receipt = receipts.get(commandId);
            if (receipt == null) send(exchange, 404, error("not_found"));
            else send(exchange, 200, receipt.deepCopy());
            return;
        }
        if (parts.length == 5 && parts[4].equals("cancel") && method.equals("POST")) {
            readBody(exchange);
            ActionCommand queued = pendingAction.get();
            if (queued != null && queued.id.equals(commandId)
                    && pendingAction.compareAndSet(queued, null)) {
                receipts.put(commandId, receipt(commandId, "cancelled", null, true));
            } else if (activeAction != null && activeAction.command.id.equals(commandId)) {
                cancelRequested.set(commandId);
            }
            JsonObject receipt = receipts.get(commandId);
            if (receipt == null) send(exchange, 404, error("not_found"));
            else send(exchange, 202, receipt.deepCopy());
            return;
        }
        send(exchange, 404, error("not_found"));
    }

    private void tick(MinecraftClient client) {
        if (autoConnectLocalServer && !joinAttempted && client.player == null
                && client.world == null && client.currentScreen instanceof TitleScreen) {
            joinAttempted = true;
            String addressText = "127.0.0.1:25565";
            ConnectScreen.connect(
                    client.currentScreen,
                    client,
                    ServerAddress.parse(addressText),
                    new ServerInfo("Local Minecraft Server", addressText, ServerInfo.ServerType.OTHER),
                    false,
                    null
            );
            return;
        }
        if (client.player == null || client.world == null) {
            if (activeAction != null) finishAction("failed", "client_not_ready");
            ActionCommand queued = pendingAction.getAndSet(null);
            if (queued != null) finishQueued(queued, "failed", "client_not_ready");
            releaseControls(client);
            observations.clear();
            playerUuid = null;
            return;
        }

        boolean gameMenuOpen = client.currentScreen instanceof GameMenuScreen;
        if (gameMenuOpen && !gameMenuLogged) {
            System.out.println("[Prism Agent Bridge] Game menu opened.");
        }
        gameMenuLogged = gameMenuOpen;

        playerUuid = client.player.getUuid().toString();
        ActionCommand queued = pendingAction.getAndSet(null);
        if (queued != null) beginAction(client, queued);
        if (activeAction != null) advanceAction(client);

        if (++tickCounter % 10 == 0) {
            try {
                observations.publish(observe(client));
            } catch (Exception error) {
                observations.clear();
            }
        }
    }

    private void beginAction(MinecraftClient client, ActionCommand command) {
        String id = safeString(command.action, "id");
        try {
            boolean resumeMenu = id.equals("resume_game")
                    && client.currentScreen instanceof GameMenuScreen;
            if ((client.currentScreen != null && !resumeMenu)
                    || (id.equals("resume_game") && !resumeMenu)
                    || client.player == null || client.world == null) {
                finishQueued(command, "failed", "client_not_ready");
                return;
            }
            if (observations.current().sequence() - command.basedOnSequence > 2) {
                finishQueued(command, "failed", "stale_observation");
                return;
            }
            CraftState craft = validateAction(command.action, id, client);
            switch (id) {
                case "resume_game" -> {
                    client.setScreen(null);
                    finishQueued(command, "completed", null);
                    return;
                }
                case "wait_20_ticks" -> activeAction = new ActiveAction(
                        command, id, System.nanoTime() + 5_000_000_000L);
                case "look_at_observed_block" -> {
                    pointAt(client, blockPosition(command.action));
                    finishQueued(command, "completed", null);
                    return;
                }
                case "move_near_observed_position" -> {
                    BlockPos target = blockPosition(command.action);
                    int dx = Integer.signum(target.getX() - client.player.getBlockX());
                    int dz = Integer.signum(target.getZ() - client.player.getBlockZ());
                    float yaw = (float) Math.toDegrees(Math.atan2(-dx, -dz) - Math.PI);
                    client.player.setYaw(MathHelper.wrapDegrees(yaw));
                    activeAction = new ActiveAction(
                            command, id, System.nanoTime() + 10_000_000_000L);
                    activeAction.target = target;
                    activeAction.dx = dx;
                    activeAction.dz = dz;
                    activeAction.radius = Math.toIntExact(integer(command.action, "radius"));
                    activeAction.movementSteps = Math.abs(target.getX() - client.player.getBlockX())
                            + Math.abs(target.getZ() - client.player.getBlockZ());
                }
                case "mine_observed_log" -> {
                    BlockPos target = blockPosition(command.action);
                    activeAction = new ActiveAction(
                            command, id, System.nanoTime() + 20_000_000_000L);
                    activeAction.target = target;
                    activeAction.minedItem = client.world.getBlockState(target).getBlock().asItem();
                    activeAction.initialItemCount = itemCount(
                            client.player.getInventory(), activeAction.minedItem);
                    pointAt(client, target);
                }
                case "craft_planks_from_logs", "craft_sticks_from_planks", "craft_table_from_planks" -> {
                    activeAction = new ActiveAction(
                            command, id, System.nanoTime() + 5_000_000_000L);
                    activeAction.craft = craft;
                }
                default -> throw new IllegalArgumentException();
            }
            receipts.put(command.id, receipt(command.id, "running", null, false));
        } catch (Exception error) {
            releaseControls(client);
            finishQueued(command, "failed", "invalid_action");
        }
    }

    private void advanceAction(MinecraftClient client) {
        ActiveAction action = activeAction;
        if (action == null) return;
        if (cancelRequested.compareAndSet(action.command.id, null)) {
            finishAction("cancelled", null);
            return;
        }
        if (client.currentScreen != null || client.player == null || client.world == null) {
            finishAction("cancelled", "manual_input");
            return;
        }
        if (System.nanoTime() >= action.deadlineNanos) {
            finishAction("failed", "timeout");
            return;
        }

        if (action.id.equals("wait_20_ticks")) {
            long requestedStart = integer(action.command.action, "startTick");
            if (client.world.getTime() - requestedStart >= 20) finishAction("completed", null);
            return;
        }

        if (action.id.equals("move_near_observed_position")) {
            if (manualMovementDown(client)) {
                finishAction("cancelled", "manual_input");
                return;
            }
            if (distanceToBlock(client.player.getBlockPos(), action.target) <= action.radius) {
                finishAction("completed", null);
                return;
            }
            if (!safeStep(
                    client.world,
                    client.player.getBlockPos(),
                    action.dx,
                    action.dz,
                    action.movementSteps)) {
                finishAction("failed", "path_blocked");
                return;
            }
            client.options.forwardKey.setPressed(true);
            ownsForwardKey = true;
            return;
        }
        if (action.id.equals("mine_observed_log")) {
            advanceMining(client, action);
            return;
        }
        if (action.craft != null) {
            advanceCrafting(client, action);
            return;
        }
        finishAction("failed", "invalid_action");
    }

    private void advanceMining(MinecraftClient client, ActiveAction action) {
        BlockState state = client.world.getBlockState(action.target);
        if (state.isAir()) {
            if (itemCount(client.player.getInventory(), action.minedItem)
                    > action.initialItemCount) finishAction("completed", null);
            return;
        }
        if (!state.isIn(BlockTags.LOGS)) {
            finishAction("failed", "target_changed");
            return;
        }
        var hit = client.player.raycast(MAX_MINING_REACH, 1.0F, false);
        if (!(hit instanceof BlockHitResult blockHit)
                || !blockHit.getBlockPos().equals(action.target)) {
            finishAction("failed", "target_not_visible");
            return;
        }
        if (!action.breakingStarted) {
            action.breakingStarted = client.interactionManager.attackBlock(
                    action.target, Direction.UP);
            if (!action.breakingStarted) finishAction("failed", "break_rejected");
            return;
        }
        client.interactionManager.updateBlockBreakingProgress(action.target, Direction.UP);
    }

    private void advanceCrafting(MinecraftClient client, ActiveAction action) {
        if (!(client.player.currentScreenHandler instanceof PlayerScreenHandler handler)) {
            finishAction("failed", "inventory_closed");
            return;
        }
        CraftState craft = action.craft;
        if (craft.stage < craft.gridSlots.length * 3) {
            int stage = craft.stage % 3;
            int gridSlot = craft.gridSlots[craft.stage / 3];
            if (stage == 0) {
                ItemStack source = handler.getSlot(craft.sourceSlot).getStack();
                if (!handler.getCursorStack().isEmpty() || !source.isOf(craft.inputItem)
                        || source.isEmpty() || !handler.getSlot(gridSlot).getStack().isEmpty()) {
                    finishAction("failed", "input_changed");
                    return;
                }
                client.interactionManager.clickSlot(
                        handler.syncId,
                        craft.sourceSlot,
                        0,
                        SlotActionType.PICKUP,
                        client.player);
            } else if (stage == 1) {
                ItemStack cursor = handler.getCursorStack();
                if (!cursor.isOf(craft.inputItem) || cursor.isEmpty()
                        || !handler.getSlot(gridSlot).getStack().isEmpty()) {
                    finishAction("failed", "input_changed");
                    return;
                }
                client.interactionManager.clickSlot(
                        handler.syncId,
                        gridSlot,
                        1,
                        SlotActionType.PICKUP,
                        client.player);
            } else {
                ItemStack placed = handler.getSlot(gridSlot).getStack();
                ItemStack cursor = handler.getCursorStack();
                if (!placed.isOf(craft.inputItem) || placed.getCount() != 1
                        || (!cursor.isEmpty() && (!cursor.isOf(craft.inputItem)
                                || !handler.getSlot(craft.sourceSlot).getStack().isEmpty()))) {
                    finishAction("failed", "input_changed");
                    return;
                }
                if (!cursor.isEmpty()) {
                    client.interactionManager.clickSlot(
                            handler.syncId,
                            craft.sourceSlot,
                            0,
                            SlotActionType.PICKUP,
                            client.player);
                }
            }
            craft.stage++;
            return;
        }

        if (!craft.submitted) {
            ItemStack result = handler.getSlot(0).getStack();
            if (result.isEmpty()) return;
            if (!result.isOf(craft.outputItem) || result.getCount() != craft.outputCount
                    || !hasInventoryRoom(handler, result, -1, 0)) {
                finishAction("failed", "recipe_unavailable");
                return;
            }
            client.interactionManager.clickSlot(
                    handler.syncId,
                    0,
                    0,
                    SlotActionType.QUICK_MOVE,
                    client.player);
            craft.submitted = true;
            return;
        }

        int inputConsumed = craft.initialInputCount
                - itemCount(client.player.getInventory(), craft.inputItem);
        int outputGained = itemCount(client.player.getInventory(), craft.outputItem)
                - craft.initialOutputCount;
        if (inputConsumed == craft.inputCount && outputGained >= craft.outputCount) {
            finishAction("completed", null);
        }
    }

    private CraftState validateAction(JsonObject action, String id, MinecraftClient client) {
        if (!ACTION_IDS.contains(id)) throw new IllegalArgumentException();
        Set<String> expectedFields = switch (id) {
            case "resume_game" -> Set.of("id", "timeoutMs");
            case "wait_20_ticks" -> Set.of("id", "timeoutMs", "startTick");
            case "look_at_observed_block" -> Set.of("id", "timeoutMs", "target");
            case "move_near_observed_position" -> Set.of("id", "timeoutMs", "target", "radius");
            case "mine_observed_log" -> Set.of("id", "timeoutMs", "target");
            case "craft_planks_from_logs", "craft_sticks_from_planks", "craft_table_from_planks" ->
                    Set.of("id", "timeoutMs", "inputItem");
            default -> throw new IllegalArgumentException();
        };
        if (!action.keySet().equals(expectedFields)) throw new IllegalArgumentException();
        int timeout = Math.toIntExact(integer(action, "timeoutMs"));
        long expected = switch (id) {
            case "resume_game" -> 2_000;
            case "wait_20_ticks" -> 5_000;
            case "look_at_observed_block" -> 2_000;
            case "move_near_observed_position" -> 10_000;
            case "mine_observed_log" -> 20_000;
            case "craft_planks_from_logs", "craft_sticks_from_planks", "craft_table_from_planks" -> 5_000;
            default -> throw new IllegalArgumentException();
        };
        if (timeout != expected) throw new IllegalArgumentException();

        if (id.equals("resume_game")) return null;
        if (id.equals("wait_20_ticks")) {
            long start = integer(action, "startTick");
            long now = client.world.getTime();
            if (start > now || now - start > 20) throw new IllegalArgumentException();
            return null;
        }
        if (id.equals("craft_planks_from_logs")
                || id.equals("craft_sticks_from_planks")
                || id.equals("craft_table_from_planks")) {
            return craftState(client, action, id);
        }

        BlockPos target = blockPosition(action);
        if (id.equals("look_at_observed_block")) {
            if (client.player.getBlockPos().getManhattanDistance(target) > 8
                    || client.world.getBlockState(target).isAir()) {
                throw new IllegalArgumentException();
            }
            return null;
        }

        if (id.equals("mine_observed_log")) {
            BlockState state = client.world.getBlockState(target);
            if (!client.world.getRegistryKey().equals(World.OVERWORLD)
                    || !state.isIn(BlockTags.LOGS)
                    || client.player.getEyePos().distanceTo(target.toCenterPos()) > MAX_MINING_REACH
                    || !hasInventoryRoom(
                            client.player.currentScreenHandler,
                            new ItemStack(state.getBlock().asItem()),
                            -1,
                            0)) {
                throw new IllegalArgumentException();
            }
            return null;
        }

        if (manualMovementDown(client)) throw new IllegalArgumentException();
        int dx = target.getX() - client.player.getBlockX();
        int dz = target.getZ() - client.player.getBlockZ();
        int steps = Math.abs(dx) + Math.abs(dz);
        long radius = integer(action, "radius");
        if (target.getY() != client.player.getBlockY()
                || !((steps == 1 && radius == 0) || (steps == 2 && radius == 1))
                || (dx != 0 && dz != 0)
                || safeMovementTargets(client.world, client.player.getPos()).stream()
                .noneMatch(candidate -> candidate.equals(target))) {
            throw new IllegalArgumentException();
        }
        return null;
    }

    private CraftState craftState(MinecraftClient client, JsonObject action, String id) {
        String inputName = string(action, "inputItem");
        Item input = itemByName(inputName);
        Item output = craftingOutput(id, inputName, input);
        int inputCount = craftingInputCount(id);
        int outputCount = craftingOutputCount(id);
        if (!(client.player.currentScreenHandler instanceof PlayerScreenHandler handler)
                || !handler.getCursorStack().isEmpty()) {
            throw new IllegalArgumentException();
        }
        for (int slot = 1; slot <= 4; slot++) {
            if (!handler.getSlot(slot).getStack().isEmpty()) throw new IllegalArgumentException();
        }
        int sourceSlot = findInventorySlot(handler, input, inputCount);
        ItemStack outputStack = new ItemStack(output, outputCount);
        if (sourceSlot < 0 || !hasInventoryRoom(handler, outputStack, sourceSlot, inputCount)) {
            throw new IllegalArgumentException();
        }
        int[] gridSlots = switch (id) {
            case "craft_planks_from_logs" -> new int[] {1};
            case "craft_sticks_from_planks" -> new int[] {1, 3};
            case "craft_table_from_planks" -> new int[] {1, 2, 3, 4};
            default -> throw new IllegalArgumentException();
        };
        return new CraftState(
                input,
                output,
                inputCount,
                outputCount,
                itemCount(client.player.getInventory(), input),
                itemCount(client.player.getInventory(), output),
                sourceSlot,
                gridSlots);
    }

    private Item craftingOutput(String id, String inputName, Item input) {
        return switch (id) {
            case "craft_planks_from_logs" -> {
                if (!input.getDefaultStack().isIn(ItemTags.LOGS)) throw new IllegalArgumentException();
                yield planksForLog(inputName);
            }
            case "craft_sticks_from_planks" -> {
                if (!input.getDefaultStack().isIn(ItemTags.PLANKS) || !isSupportedPlanks(inputName)) {
                    throw new IllegalArgumentException();
                }
                yield Items.STICK;
            }
            case "craft_table_from_planks" -> {
                if (!input.getDefaultStack().isIn(ItemTags.PLANKS) || !isSupportedPlanks(inputName)) {
                    throw new IllegalArgumentException();
                }
                yield Items.CRAFTING_TABLE;
            }
            default -> throw new IllegalArgumentException();
        };
    }

    private Item itemByName(String name) {
        Identifier identifier = Identifier.of("minecraft", name);
        Item item = Registries.ITEM.get(identifier);
        if (item == Items.AIR || !Registries.ITEM.getId(item).equals(identifier)) {
            throw new IllegalArgumentException();
        }
        return item;
    }

    private Item planksForLog(String inputName) {
        String name = inputName.startsWith("stripped_")
                ? inputName.substring("stripped_".length()) : inputName;
        String wood = null;
        for (String suffix : List.of("_log", "_wood", "_stem", "_hyphae")) {
            if (name.endsWith(suffix)) {
                wood = name.substring(0, name.length() - suffix.length());
                break;
            }
        }
        if (!WOOD_TYPES.contains(wood)) throw new IllegalArgumentException();
        return itemByName(wood + "_planks");
    }

    private boolean isSupportedPlanks(String name) {
        return name.endsWith("_planks")
                && WOOD_TYPES.contains(name.substring(0, name.length() - "_planks".length()));
    }

    private int craftingInputCount(String id) {
        return switch (id) {
            case "craft_planks_from_logs" -> 1;
            case "craft_sticks_from_planks" -> 2;
            case "craft_table_from_planks" -> 4;
            default -> throw new IllegalArgumentException();
        };
    }

    private int craftingOutputCount(String id) {
        return switch (id) {
            case "craft_planks_from_logs", "craft_sticks_from_planks" -> 4;
            case "craft_table_from_planks" -> 1;
            default -> throw new IllegalArgumentException();
        };
    }

    private int findInventorySlot(PlayerScreenHandler handler, Item item, int count) {
        for (int index = 9; index <= 44; index++) {
            ItemStack stack = handler.getSlot(index).getStack();
            if (stack.isOf(item) && stack.getCount() >= count) return index;
        }
        return -1;
    }

    private boolean hasInventoryRoom(
            net.minecraft.screen.ScreenHandler handler,
            ItemStack output,
            int consumedSlot,
            int consumedCount) {
        int capacity = 0;
        for (int index = 9; index <= 44; index++) {
            var slot = handler.getSlot(index);
            if (!slot.canInsert(output)) continue;
            ItemStack stack = slot.getStack();
            int limit = slot.getMaxItemCount(output);
            if (index == consumedSlot && stack.getCount() == consumedCount) capacity += limit;
            else if (stack.isEmpty()) capacity += limit;
            else if (ItemStack.areItemsAndComponentsEqual(stack, output)) {
                capacity += limit - stack.getCount();
            }
            if (capacity >= output.getCount()) return true;
        }
        return false;
    }

    private int itemCount(PlayerInventory inventory, Item item) {
        return inventory.getMainStacks().stream()
                .filter(stack -> stack.isOf(item))
                .mapToInt(ItemStack::getCount)
                .sum();
    }

    private void pointAt(MinecraftClient client, BlockPos target) {
        double dx = target.getX() + 0.5 - client.player.getX();
        double dy = target.getY() + 0.5 - client.player.getY() - client.player.getEyeHeight(client.player.getPose());
        double dz = target.getZ() + 0.5 - client.player.getZ();
        double horizontal = Math.hypot(dx, dz);
        double targetYaw = Math.atan2(-dx, -dz);
        double targetPitch = Math.atan2(dy, horizontal);
        float gameYaw = (float) Math.toDegrees(targetYaw - Math.PI);
        float gamePitch = (float) -Math.toDegrees(targetPitch);
        client.player.setYaw(MathHelper.wrapDegrees(gameYaw));
        client.player.setPitch(gamePitch);
        client.player.setHeadYaw(MathHelper.wrapDegrees(gameYaw));
    }

    private void finishAction(String status, String reason) {
        ActiveAction action = activeAction;
        if (action == null) return;
        MinecraftClient client = MinecraftClient.getInstance();
        if (action.id.equals("mine_observed_log") && client.interactionManager != null) {
            client.interactionManager.cancelBlockBreaking();
        }
        if (action.craft != null && !cleanupCrafting(client, action)) {
            status = "failed";
            reason = "craft_cleanup_failed";
        }
        activeAction = null;
        releaseControls(client);
        receipts.put(action.command.id, receipt(action.command.id, status, reason, true));
    }

    private boolean cleanupCrafting(MinecraftClient client, ActiveAction action) {
        if (client.player == null || client.interactionManager == null
                || !(client.player.currentScreenHandler instanceof PlayerScreenHandler handler)) {
            return false;
        }
        CraftState craft = action.craft;
        if (!returnCraftInput(client, handler, craft.sourceSlot, craft.inputItem)) return false;
        for (int gridSlot : craft.gridSlots) {
            ItemStack input = handler.getSlot(gridSlot).getStack();
            if (input.isEmpty()) continue;
            if (!input.isOf(craft.inputItem) || !handler.getCursorStack().isEmpty()) return false;
            client.interactionManager.clickSlot(
                    handler.syncId,
                    gridSlot,
                    0,
                    SlotActionType.PICKUP,
                    client.player);
            if (!handler.getCursorStack().isOf(craft.inputItem)
                    || !handler.getSlot(gridSlot).getStack().isEmpty()) return false;
            if (!returnCraftInput(client, handler, craft.sourceSlot, craft.inputItem)) {
                client.interactionManager.clickSlot(
                        handler.syncId,
                        gridSlot,
                        0,
                        SlotActionType.PICKUP,
                        client.player);
                return false;
            }
        }
        return handler.getCursorStack().isEmpty();
    }

    private boolean returnCraftInput(
            MinecraftClient client,
            PlayerScreenHandler handler,
            int sourceSlot,
            Item inputItem) {
        ItemStack carried = handler.getCursorStack();
        if (carried.isEmpty()) return true;
        if (!carried.isOf(inputItem)) return false;
        for (int index = 0; index <= 36; index++) {
            int targetSlot = index == 0 ? sourceSlot : index + 8;
            if (index > 0 && targetSlot == sourceSlot) continue;
            var slot = handler.getSlot(targetSlot);
            ItemStack existing = slot.getStack();
            if (!slot.canInsert(carried)
                    || (!existing.isEmpty()
                            && !ItemStack.areItemsAndComponentsEqual(existing, carried))
                    || slot.getMaxItemCount(carried) - existing.getCount() < carried.getCount()) {
                continue;
            }
            client.interactionManager.clickSlot(
                    handler.syncId,
                    targetSlot,
                    0,
                    SlotActionType.PICKUP,
                    client.player);
            return handler.getCursorStack().isEmpty();
        }
        return false;
    }

    private void finishQueued(ActionCommand command, String status, String reason) {
        receipts.put(command.id, receipt(command.id, status, reason, true));
    }

    private void releaseControls(MinecraftClient client) {
        if (ownsForwardKey && client.options != null) {
            client.options.forwardKey.setPressed(false);
            ownsForwardKey = false;
        }
    }

    private boolean manualMovementDown(MinecraftClient client) {
        long window = client.getWindow().getHandle();
        return List.of(
                client.options.forwardKey,
                client.options.backKey,
                client.options.leftKey,
                client.options.rightKey,
                client.options.jumpKey,
                client.options.sprintKey,
                client.options.sneakKey
        ).stream().anyMatch(key ->
                InputUtil.isKeyPressed(window, key.getDefaultKey().getCode()));
    }

    private JsonObject observe(MinecraftClient client) {
        var player = client.player;
        World world = client.world;
        var position = player.getPos();
        JsonObject value = new JsonObject();
        value.add("position", position(position.x, position.y, position.z));
        value.addProperty("eyeHeight", player.getEyeHeight(player.getPose()));
        value.addProperty("dimension", world.getRegistryKey().getValue().toString());
        value.addProperty("health", player.getHealth());
        value.addProperty("food", player.getHungerManager().getFoodLevel());
        Difficulty difficulty = world.getDifficulty();
        value.addProperty("difficulty", difficulty.getName());
        value.addProperty("tick", world.getTime());
        value.addProperty("yaw", Math.toRadians(MathHelper.wrapDegrees(player.getYaw() + 180.0f)));
        value.addProperty("pitch", -Math.toRadians(player.getPitch()));
        value.addProperty("gameMenuOpen", client.currentScreen instanceof GameMenuScreen);
        value.addProperty("screenOpen", client.currentScreen != null);

        JsonArray inventory = new JsonArray();
        PlayerInventory playerInventory = player.getInventory();
        for (ItemStack stack : playerInventory.getMainStacks()) {
            if (stack.isEmpty()) continue;
            JsonObject item = new JsonObject();
            item.addProperty("name", Registries.ITEM.getId(stack.getItem()).getPath());
            item.addProperty("count", stack.getCount());
            inventory.add(item);
            if (inventory.size() == 100) break;
        }
        value.add("inventory", inventory);

        JsonArray nearby = new JsonArray();
        nearbyBlocks(world, position, player).forEach(block -> nearby.add(block));
        value.add("nearbyBlocks", nearby);
        JsonArray targets = new JsonArray();
        safeMovementTargets(world, position).forEach(target -> targets.add(position(
                target.getX(), target.getY(), target.getZ())));
        value.add("safeMovementTargets", targets);
        return value;
    }

    private List<JsonObject> nearbyBlocks(
            World world, net.minecraft.util.math.Vec3d position, Entity player) {
        List<BlockEntry> blocks = new ArrayList<>();
        BlockPos origin = BlockPos.ofFloored(position);
        net.minecraft.util.math.Vec3d eyePosition = player.getEyePos();
        BlockPos.Mutable mutable = new BlockPos.Mutable();
        for (int x = -8; x <= 8; x++) {
            for (int y = -8; y <= 8; y++) {
                for (int z = -8; z <= 8; z++) {
                    if (x * x + y * y + z * z > 64) continue;
                    mutable.set(origin.getX() + x, origin.getY() + y, origin.getZ() + z);
                    BlockState state = world.getBlockState(mutable);
                    if (state.isAir()) continue;
                    String name = Registries.BLOCK.getId(state.getBlock()).getPath();
                    BlockPos blockPosition = mutable.toImmutable();
                    double distance = blockPosition.toCenterPos().distanceTo(eyePosition);
                    Boolean visible = state.isIn(BlockTags.LOGS) && distance <= MAX_MINING_REACH
                            ? isVisibleBlock(world, blockPosition, eyePosition, player)
                            : null;
                    blocks.add(new BlockEntry(name, blockPosition, distance, visible));
                }
            }
        }
        blocks.sort((left, right) -> {
            int priority = Boolean.compare(
                    Boolean.TRUE.equals(right.visible), Boolean.TRUE.equals(left.visible));
            return priority == 0 ? Double.compare(left.distance, right.distance) : priority;
        });
        List<JsonObject> result = new ArrayList<>();
        for (BlockEntry block : blocks.stream().limit(16).toList()) {
            JsonObject value = new JsonObject();
            value.addProperty("name", block.name);
            value.add("position", position(
                    block.position.getX(), block.position.getY(), block.position.getZ()));
            value.addProperty("visible", block.visible != null
                    ? block.visible
                    : isVisibleBlock(world, block.position, eyePosition, player));
            result.add(value);
        }
        return result;
    }

    private boolean isVisibleBlock(
            World world,
            BlockPos position,
            net.minecraft.util.math.Vec3d eyePosition,
            Entity player) {
        BlockHitResult hit = world.raycast(new RaycastContext(
                eyePosition,
                position.toCenterPos(),
                RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.NONE,
                player));
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(position);
    }

    private List<BlockPos> safeMovementTargets(World world, net.minecraft.util.math.Vec3d position) {
        int baseX = MathHelper.floor(position.x);
        int baseY = MathHelper.floor(position.y);
        int baseZ = MathHelper.floor(position.z);
        List<BlockPos> targets = new ArrayList<>();
        int[][] directions = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int[] direction : directions) {
            int clearDistance = 0;
            for (int distance = 1; distance <= 2; distance++) {
                int x = baseX + direction[0] * distance;
                int z = baseZ + direction[1] * distance;
                BlockPos floor = new BlockPos(x, baseY - 1, z);
                BlockPos feet = new BlockPos(x, baseY, z);
                BlockPos head = new BlockPos(x, baseY + 1, z);
                if (!solidFloor(world, floor) || !passable(world, feet)
                        || !passable(world, head) || hazard(world, floor)
                        || hazard(world, feet) || hazard(world, head)) {
                    break;
                }
                clearDistance = distance;
            }
            if (clearDistance > 0) targets.add(new BlockPos(
                    baseX + direction[0] * clearDistance,
                    baseY,
                    baseZ + direction[1] * clearDistance));
        }
        return targets;
    }

    private boolean safeStep(World world, BlockPos current, int dx, int dz, int steps) {
        for (int distance = 1; distance <= steps; distance++) {
            BlockPos floor = current.add(dx * distance, -1, dz * distance);
            BlockPos feet = current.add(dx * distance, 0, dz * distance);
            BlockPos head = current.add(dx * distance, 1, dz * distance);
            if (!solidFloor(world, floor) || !passable(world, feet)
                    || !passable(world, head) || hazard(world, floor)
                    || hazard(world, feet) || hazard(world, head)) return false;
        }
        return true;
    }

    private boolean solidFloor(World world, BlockPos position) {
        BlockState state = world.getBlockState(position);
        return state.isSolidBlock(world, position);
    }

    private boolean passable(World world, BlockPos position) {
        return world.getBlockState(position).getCollisionShape(world, position).isEmpty();
    }

    private boolean hazard(World world, BlockPos position) {
        return HAZARDS.contains(Registries.BLOCK.getId(
                world.getBlockState(position).getBlock()).getPath());
    }

    private void captureFrame() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null || client.world == null) return;
        if (!frameBusy.compareAndSet(false, true)) return;
        long now = System.nanoTime();
        if (now - lastFrameNanos < 1_000_000_000L / 30L) {
            frameBusy.set(false);
            return;
        }
        lastFrameNanos = now;
        try {
            int width = client.getWindow().getFramebufferWidth();
            int height = client.getWindow().getFramebufferHeight();
            int downscale = screenshotDownscale(width, height);
            ScreenshotRecorder.takeScreenshot(client.getFramebuffer(), downscale, image -> {
                try {
                    frameEncoder.execute(() -> encodeFrame(image));
                } catch (RejectedExecutionException error) {
                    image.close();
                    frameBusy.set(false);
                }
            });
        } catch (RuntimeException error) {
            frameBusy.set(false);
        }
    }

    private int screenshotDownscale(int width, int height) {
        int desired = Math.max(1, (int) Math.round(Math.min(width / 640.0, height / 360.0)));
        int common = greatestCommonDivisor(width, height);
        int factor = 1;
        int distance = Math.abs(desired - factor);
        for (int candidate = 2; candidate <= common; candidate++) {
            if (common % candidate != 0 || width / candidate < 320 || height / candidate < 180) {
                continue;
            }
            int candidateDistance = Math.abs(desired - candidate);
            if (candidateDistance < distance) {
                factor = candidate;
                distance = candidateDistance;
            }
        }
        return factor;
    }

    private int greatestCommonDivisor(int left, int right) {
        while (right != 0) {
            int remainder = left % right;
            left = right;
            right = remainder;
        }
        return left;
    }

    private void encodeFrame(NativeImage image) {
        try {
            int width = image.getWidth();
            int height = image.getHeight();
            int[] abgr = image.copyPixelsAbgr();
            BufferedImage rgb = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            int[] argb = ((DataBufferInt) rgb.getRaster().getDataBuffer()).getData();
            for (int i = 0; i < abgr.length; i++) {
                int pixel = abgr[i];
                argb[i] = (pixel & 0xff00ff00)
                        | ((pixel & 0x00ff0000) >>> 16)
                        | ((pixel & 0x000000ff) << 16);
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
            if (!writers.hasNext()) return;
            ImageWriter writer = writers.next();
            try (MemoryCacheImageOutputStream output = new MemoryCacheImageOutputStream(bytes)) {
                writer.setOutput(output);
                ImageWriteParam params = writer.getDefaultWriteParam();
                params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                params.setCompressionQuality(0.72f);
                writer.write(null, new IIOImage(rgb, null, null), params);
            } finally {
                writer.dispose();
            }
            byte[] frame = bytes.toByteArray();
            if (frame.length <= MAX_FRAME_BYTES) {
                latestFrame.set(new CapturedFrame(++frameRevision, frame));
            }
        } catch (Exception error) {
        } finally {
            try {
                image.close();
            } finally {
                frameBusy.set(false);
            }
        }
    }

    private static double distanceToBlock(BlockPos from, BlockPos to) {
        return Math.sqrt(Math.pow(from.getX() - to.getX(), 2)
                + Math.pow(from.getY() - to.getY(), 2)
                + Math.pow(from.getZ() - to.getZ(), 2));
    }

    private static BlockPos blockPosition(JsonObject action) {
        JsonObject target = action.getAsJsonObject("target");
        if (target == null) throw new IllegalArgumentException();
        int x = Math.toIntExact(integer(target, "x"));
        int y = Math.toIntExact(integer(target, "y"));
        int z = Math.toIntExact(integer(target, "z"));
        return new BlockPos(x, y, z);
    }

    private static JsonObject position(double x, double y, double z) {
        JsonObject value = new JsonObject();
        value.addProperty("x", x);
        value.addProperty("y", y);
        value.addProperty("z", z);
        return value;
    }

    private static String string(JsonObject value, String key) {
        JsonElement element = value.get(key);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException();
        }
        return element.getAsString();
    }

    private static String safeString(JsonObject value, String key) {
        try {
            return string(value, key);
        } catch (Exception error) {
            return "";
        }
    }

    private static long integer(JsonObject value, String key) {
        JsonElement element = value.get(key);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException();
        }
        double number = element.getAsDouble();
        if (!Double.isFinite(number) || number != Math.rint(number)) {
            throw new IllegalArgumentException();
        }
        return element.getAsLong();
    }

    private static boolean isUuid(String value) {
        try {
            UUID.fromString(value);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private static JsonObject error(String code) {
        JsonObject value = new JsonObject();
        value.addProperty("error", code);
        return value;
    }

    private static JsonObject receipt(String id, String status, String reason, boolean released) {
        JsonObject value = new JsonObject();
        value.addProperty("commandId", id);
        value.addProperty("status", status);
        if (reason != null) value.addProperty("reason", reason);
        value.addProperty("controlsReleased", released);
        return value;
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
        if (body.length > MAX_BODY_BYTES) throw new BodyTooLarge();
        return new String(body, StandardCharsets.UTF_8);
    }

    private static void send(HttpExchange exchange, int status, JsonObject value) throws IOException {
        byte[] body = value.toString().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("cache-control", "no-store");
        exchange.getResponseHeaders().set("x-content-type-options", "nosniff");
        exchange.sendResponseHeaders(status, body.length);
        exchange.getResponseBody().write(body);
    }

    private void pruneReceipts() {
        if (receipts.size() <= 10) return;
        receipts.keySet().stream().limit(receipts.size() - 10L).forEach(receipts::remove);
    }

    private record ActionCommand(String id, long basedOnSequence, JsonObject action) {
    }

    private record BlockEntry(String name, BlockPos position, double distance, Boolean visible) {
    }

    private static final class ActiveAction {
        private final ActionCommand command;
        private final String id;
        private final long deadlineNanos;
        private BlockPos target;
        private int dx;
        private int dz;
        private int radius;
        private int movementSteps;
        private Item minedItem;
        private int initialItemCount;
        private boolean breakingStarted;
        private CraftState craft;

        private ActiveAction(ActionCommand command, String id, long deadlineNanos) {
            this.command = command;
            this.id = id;
            this.deadlineNanos = deadlineNanos;
        }
    }

    private static final class CraftState {
        private final Item inputItem;
        private final Item outputItem;
        private final int inputCount;
        private final int outputCount;
        private final int initialInputCount;
        private final int initialOutputCount;
        private final int sourceSlot;
        private final int[] gridSlots;
        private int stage;
        private boolean submitted;

        private CraftState(
                Item inputItem,
                Item outputItem,
                int inputCount,
                int outputCount,
                int initialInputCount,
                int initialOutputCount,
                int sourceSlot,
                int[] gridSlots) {
            this.inputItem = inputItem;
            this.outputItem = outputItem;
            this.inputCount = inputCount;
            this.outputCount = outputCount;
            this.initialInputCount = initialInputCount;
            this.initialOutputCount = initialOutputCount;
            this.sourceSlot = sourceSlot;
            this.gridSlots = gridSlots;
        }
    }

    private static final class BodyTooLarge extends RuntimeException {
    }
}
