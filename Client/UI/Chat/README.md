# Sample chat adapter

`ChatRpcAdapter` implements the published Client preflight/committed hooks. It matches
`nameof(ChatComponent)` / `nameof(ChatComponent.OnChatMessage)` from Sample Gameplay,
without initializing its registry. Preflight rejects malformed recognized room RPCs
before publication. Observation copies immutable text and scalar identities without
looking up a live entity. Two high-water marks reject presentation regressions while
the Client receipt remains Applied. History has no new eviction policy.

`ChatConsumer.Create(IClientReplicaFactory, Action<ChatLine>? = null)` creates a fresh
adapter and calls `factory.Create(GeneratedRegistry.Instance, in hooks)` before any
stage. Explicit consumer composition initializes Sample's client registry; standalone
observer construction does not register input mappings. Supply a factory whose
manager has Sample config, the client registry and the host's HFSM/clock provider.

Use `consumer.Replica` in the existing authority/session pipeline, and
`consumer.CopySnapshot()` for immutable `ChatPresentation` reads (`Lines`,
`MessageHighWater`, `RoomSequenceHighWater`, `LastError`). `ChatLine` contains
`MessageId`, `RoomSequence`, `Sender`, `Text`, and `AppliedTick`. Snapshots are copied
and remain valid after reset/disposal. All calls belong on the replica owner thread.
Dispose the consumer when retiring its replica. Client owns safe-point detachment,
hook disposal and retryable native cleanup; do not attach the adapter to another replica.

For hosts already composing hooks, create one `ChatRpcAdapter`, pass
`new ReplicaRpcHooks(adapter, adapter)` to the factory's hooks overload and read
`adapter.CopySnapshot()`. A throwing optional line callback is isolated by Client
per RPC; cursors advance before append/callback, and failures never request replay.

## Build and tests

The only direct project reference is Sample's own Gameplay. Client is an explicit
prebuilt assembly reference; no private Client source project is referenced and no
fallback search is performed. Build Client first with the settled Runtime/Engine
roots, then query its `TargetPath` using `dotnet msbuild -getProperty:TargetPath`.
Pass that exact netstandard2.1 artifact as `LumioClientGameplayEcsAssembly`.

Use these properties for **restore and build**, including from a net10 test host:

```text
-p:LumioEcsSide=client -p:LumioBrowserReplica=true
-p:LumioClientGameplayEcsAssembly=<exact prebuilt Lumio.Client.Gameplay.ECS.dll>
```

NuGet restore does not propagate `ProjectReference.AdditionalProperties`; omitting
the global projection flags fails explicitly. The engine SDK resolves from the `Engine/`
submodule only (ADR-123), like every other project here. Production is C# 9 / netstandard2.1;
its graph includes the portable HFSM facade, not net10 NativeLoader.

Build `Client/UI/Chat/Lumio.Sample.Client.Chat.csproj`. Run the separate test project
with `dotnet test --project Client/Tests/Chat/Lumio.Sample.Client.Chat.Tests.csproj`
and `--minimum-expected-tests 1`, supplying the same properties plus
`LumioNativeLoaderAssembly=<exact prebuilt managed NativeLoader.dll>` and
`LUMIO_NATIVE_TEST_PATH=<verified native DLL itself>`. The net10 test fixture alone
loads NativeLoader, borrows a real Native HFSM context, and installs Runtime's
test-only monotonic clock seam. Tests use real Sample config/registry and Client
staging/outcomes; the legacy Client chat matcher is set to an unrelated test identity
so it cannot provide the adapter's validation or presentation behavior.

## Integration boundary

This project does not replace Bot, Web UI or Spectator composition. Next, the Sample
Bot owner must inject this consumer's snapshot reads into the game scenario and
replace `BotWorldView.ChatWindow` usage, preserving normal Session input/uplink.
Spectator must create this consumer before its initial reset/Welcome and export
snapshot lines to the Sample-owned Web UI. Hosts using Session-owned replica factory
creation need a game-owned factory composition that supplies a fresh hook pair per
Create; attaching an observer after Session creation is too late.

Client's legacy chat source remains until those consumers migrate. The four retained
Client callback tests requiring Runtime `EnterExternalCallback` still fail at the
settled dependency revision. SDK-only/package proof, Bot migration, Web UI tests and
actual Spectator WASM publish/start remain integration obligations; this adapter is
not full R-00634 migration acceptance.
