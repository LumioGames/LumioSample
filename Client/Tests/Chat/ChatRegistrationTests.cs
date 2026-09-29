using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text;
using Lumio.GameRuntime.Ecs;
using Xunit;

namespace Lumio.Sample.Client.Chat.Tests;

public sealed class ChatRegistrationTests
{
    private delegate TResult SpanDecoder<TResult>(ReadOnlySpan<byte> bytes);

    public static class DecoderBridge
    {
        public static object Invoke<TResult>(MethodInfo method, byte[] bytes)
            => method.CreateDelegate<SpanDecoder<TResult>>()(bytes)!;
    }

    [Fact]
    public void ConstructingAdapterDoesNotRegisterInputButExplicitGameplayRegistryDoes()
    {
        var isolated = new IsolatedContext();
        try
        {
            var input = new InputCommandMessage(1, "chat.input", new NetEntityId(1, 1), WireCodec.EncodeUtf8("hello"));
            string json = Encoding.UTF8.GetString(WireCodec.EncodeInput(input));
            var adapterType = isolated.LoadFromAssemblyName(new AssemblyName("Lumio.Sample.Client.Chat"))
                .GetType("Lumio.Sample.Client.Chat.ChatRpcAdapter", true)!;
            using var adapter = (IDisposable)Activator.CreateInstance(adapterType, new object?[] { null })!;
            Assert.False(Validate(isolated, json));
            var registryType = isolated.LoadFromAssemblyName(new AssemblyName("Lumio.Sample.Gameplay"))
                .GetType("Lumio.Sample.Gameplay.GeneratedRegistry", true)!;
            RuntimeHelpers.RunClassConstructor(registryType.TypeHandle);
            Assert.True(Validate(isolated, json));
        }
        finally { isolated.Unload(); }
    }

    private static bool Validate(AssemblyLoadContext context, string json)
    {
        var type = context.LoadFromAssemblyName(new AssemblyName("Lumio.GameRuntime.Ecs"))
            .GetType("Lumio.GameRuntime.Ecs.WireCodec", true)!;
        MethodInfo decoder = type.GetMethod("DecodeInput", BindingFlags.Public | BindingFlags.Static,
            binder: null, new[] { typeof(ReadOnlySpan<byte>) }, modifiers: null)!;
        object result = typeof(DecoderBridge).GetMethod(nameof(DecoderBridge.Invoke))!
            .MakeGenericMethod(decoder.ReturnType)
            .Invoke(null, new object[] { decoder, Encoding.UTF8.GetBytes(json) })!;
        return (bool)result.GetType().GetProperty("Succeeded")!.GetValue(result)!;
    }

    private sealed class IsolatedContext() : AssemblyLoadContext(isCollectible: true)
    {
        protected override Assembly? Load(AssemblyName assemblyName)
        {
            if (assemblyName.Name?.StartsWith("Lumio.", StringComparison.Ordinal) != true) return null;
            string path = Path.Combine(AppContext.BaseDirectory, assemblyName.Name + ".dll");
            return LoadFromAssemblyPath(path);
        }
    }
}
