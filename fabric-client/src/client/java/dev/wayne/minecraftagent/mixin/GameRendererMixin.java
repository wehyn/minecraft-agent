package dev.wayne.minecraftagent.mixin;

import dev.wayne.minecraftagent.PrismBridgeClient;
import net.minecraft.client.render.GameRenderer;
import net.minecraft.client.render.RenderTickCounter;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GameRenderer.class)
public abstract class GameRendererMixin {
    @Inject(method = "render(Lnet/minecraft/client/render/RenderTickCounter;Z)V", at = @At("TAIL"))
    private void minecraftAgent$captureCompletedFrame(
            RenderTickCounter tickCounter, boolean tick, CallbackInfo callbackInfo) {
        PrismBridgeClient.captureCompletedRender();
    }
}
