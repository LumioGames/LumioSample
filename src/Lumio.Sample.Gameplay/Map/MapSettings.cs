using System;

namespace Lumio.Sample.Gameplay.Map
{
    /// <summary>
    /// 地图生成参数。**将来这些值来自配表**（LumioConfig 编译 + typed Table Reader），
    /// 现在先由调用方直接构造；换成读配表时本类型不变，只换来源。
    /// </summary>
    public sealed class MapSettings
    {
        /// <summary>构造一组地图参数。</summary>
        /// <param name="width">地图宽（含边界墙），至少 3。</param>
        /// <param name="depth">地图深（含边界墙），至少 3。</param>
        /// <param name="seed">生成种子。同种子必须生成完全相同的地图。</param>
        /// <param name="oreVeinPercent">内部格子里矿脉所占百分比，0 到 100。</param>
        /// <exception cref="ArgumentOutOfRangeException">任一参数越界。</exception>
        public MapSettings(int width, int depth, int seed, int oreVeinPercent)
        {
            if (width < 3)
            {
                throw new ArgumentOutOfRangeException(nameof(width), width, "宽至少 3（要放得下边界墙）");
            }

            if (depth < 3)
            {
                throw new ArgumentOutOfRangeException(nameof(depth), depth, "深至少 3（要放得下边界墙）");
            }

            if (oreVeinPercent < 0 || oreVeinPercent > 100)
            {
                throw new ArgumentOutOfRangeException(nameof(oreVeinPercent), oreVeinPercent, "矿脉占比必须在 0 到 100 之间");
            }

            Width = width;
            Depth = depth;
            Seed = seed;
            OreVeinPercent = oreVeinPercent;
        }

        /// <summary>地图宽（含边界墙）。</summary>
        public int Width { get; }

        /// <summary>地图深（含边界墙）。</summary>
        public int Depth { get; }

        /// <summary>生成种子。</summary>
        public int Seed { get; }

        /// <summary>内部格子里矿脉所占百分比。</summary>
        public int OreVeinPercent { get; }
    }
}
