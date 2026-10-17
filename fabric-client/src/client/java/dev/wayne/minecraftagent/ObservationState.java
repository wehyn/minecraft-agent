package dev.wayne.minecraftagent;

import com.google.gson.JsonObject;

final class ObservationState {
    record Snapshot(long sequence, JsonObject observation) {}

    private volatile Snapshot current = new Snapshot(0, null);

    void publish(JsonObject observation) {
        Snapshot previous = current;
        current = new Snapshot(previous.sequence() + 1, observation);
    }

    void clear() {
        Snapshot previous = current;
        current = new Snapshot(previous.sequence(), null);
    }

    Snapshot current() {
        return current;
    }

    JsonObject snapshotJson() {
        Snapshot current = this.current;
        JsonObject snapshot = new JsonObject();
        snapshot.addProperty("sequence", current.sequence());
        if (current.observation() != null) {
            snapshot.add("observation", current.observation().deepCopy());
        }
        return snapshot;
    }
}
