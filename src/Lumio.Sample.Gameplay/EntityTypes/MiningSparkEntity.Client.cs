// Local 实体只出现在 .Client.cs：不上网、不进存档。服务器程序集按文件边排除本文件。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Fx;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Local FX entity. Server compilation excludes this file.</summary>
[EntityType(Mode.Local)]
[Has(typeof(MiningSparkComponent))]
public abstract class MiningSparkEntity
{
}
