namespace Lumio.Sample.Gameplay.Map
{
    /// <summary>
    /// 地图格子的种类。三种**全部是体素**——静态、不动、自身没有服务器逻辑，
    /// 按世界模型四问归为体素而不是实体（见架构仓 <c>rules/system.md</c>「世界模型」）。
    /// </summary>
    public enum CellKind : byte
    {
        /// <summary>可通行的地板。</summary>
        Floor = 0,

        /// <summary>不可破坏的边界硬墙。</summary>
        HardWall = 1,

        /// <summary>
        /// 可挖掘的矿脉。**剩余储量不在这里**——格子里只写方块类型，
        /// 储量挂在一个 ECS 实体上，两半经一条稀疏引用相连（体素设计 M6a）。
        /// 这是「既不动、又有服务器逻辑」唯一正确的拆法。
        /// </summary>
        OreVein = 2,
    }
}
