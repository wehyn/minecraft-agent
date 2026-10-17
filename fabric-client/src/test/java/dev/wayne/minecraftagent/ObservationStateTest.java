package dev.wayne.minecraftagent;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;

final class ObservationStateTest {
    @Test
    void snapshotKeepsItsObservationAndSequenceFromTheSameTick() throws Exception {
        ObservationState state = new ObservationState();
        state.publish(observation(1));
        AtomicBoolean publishing = new AtomicBoolean(true);
        CountDownLatch ready = new CountDownLatch(3);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService readers = Executors.newFixedThreadPool(4);

        try {
            Future<?> writer = readers.submit(() -> {
                start.await();
                for (long tick = 2; tick <= 50_000; tick++) state.publish(observation(tick));
                publishing.set(false);
                return null;
            });
            Future<?>[] checks = new Future<?>[3];
            for (int i = 0; i < checks.length; i++) {
                checks[i] = readers.submit(() -> {
                    ready.countDown();
                    start.await();
                    while (publishing.get()) assertSnapshotMatches(state.snapshotJson());
                    assertSnapshotMatches(state.snapshotJson());
                    return null;
                });
            }

            ready.await();
            start.countDown();
            writer.get();
            for (Future<?> check : checks) check.get();
        } finally {
            readers.shutdownNow();
        }
    }

    private static void assertSnapshotMatches(JsonObject snapshot) {
        assertEquals(snapshot.get("sequence").getAsLong(),
                snapshot.getAsJsonObject("observation").get("tick").getAsLong());
    }

    private static JsonObject observation(long tick) {
        JsonObject observation = new JsonObject();
        observation.addProperty("tick", tick);
        return observation;
    }
}
