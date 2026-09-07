using System;

namespace Lumio.Sample.Gameplay.Map
{
    /// <summary>
    /// 一张地图的格子布局。
    /// <para>
    /// <b>这是纯函数</b>：同一组 <see cref="MapSettings"/> 必须生成完全相同的布局，
    /// 与机器、平台、运行次数无关。「两轮同种子跑出同一份哈希」这条验收就架在这上面，
    /// 所以这里**刻意不用** <see cref="Random"/>——它的实现跨版本可变——而是自带一个
    /// 定死的 xorshift32。
    /// </para>
    /// <para>
    /// 本类型只算布局，不碰体素世界。把布局写进体素、按 Section 下发是引擎的事。
    /// </para>
    /// </summary>
    public sealed class MapLayout
    {
        private readonly CellKind[] cells;

        private MapLayout(int width, int depth, CellKind[] cells)
        {
            Width = width;
            Depth = depth;
            this.cells = cells;
        }

        /// <summary>地图宽（含边界墙）。</summary>
        public int Width { get; }

        /// <summary>地图深（含边界墙）。</summary>
        public int Depth { get; }

        /// <summary>按参数生成布局。</summary>
        /// <param name="settings">地图参数。</param>
        /// <returns>生成好的布局。</returns>
        /// <exception cref="ArgumentNullException"><paramref name="settings"/> 为 <see langword="null"/>。</exception>
        public static MapLayout Generate(MapSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);

            int width = settings.Width;
            int depth = settings.Depth;
            CellKind[] cells = new CellKind[width * depth];

            // 种子为 0 时 xorshift32 会永远停在 0，所以垫一个非零常量。
            uint state = unchecked((uint)settings.Seed) ^ 0x9E3779B9u;

            for (int z = 0; z < depth; z++)
            {
                for (int x = 0; x < width; x++)
                {
                    bool onBorder = x == 0 || z == 0 || x == width - 1 || z == depth - 1;
                    if (onBorder)
                    {
                        cells[(z * width) + x] = CellKind.HardWall;
                        continue;
                    }

                    // 每个内部格子都消耗一次随机数，与 OreVeinPercent 无关——
                    // 这样改占比不会让整张图的随机序列错位，同种子的地形骨架保持稳定。
                    state = NextState(state);
                    uint roll = state % 100u;
                    cells[(z * width) + x] = roll < (uint)settings.OreVeinPercent
                        ? CellKind.OreVein
                        : CellKind.Floor;
                }
            }

            return new MapLayout(width, depth, cells);
        }

        /// <summary>读一个格子。</summary>
        /// <param name="x">横坐标，0 到 <see cref="Width"/> - 1。</param>
        /// <param name="z">纵坐标，0 到 <see cref="Depth"/> - 1。</param>
        /// <returns>该格的种类。</returns>
        /// <exception cref="ArgumentOutOfRangeException">坐标越界。</exception>
        public CellKind GetCell(int x, int z)
        {
            if (x < 0 || x >= Width)
            {
                throw new ArgumentOutOfRangeException(nameof(x), x, "横坐标越界");
            }

            if (z < 0 || z >= Depth)
            {
                throw new ArgumentOutOfRangeException(nameof(z), z, "纵坐标越界");
            }

            return cells[(z * Width) + x];
        }

        /// <summary>数一数某种格子有多少个。</summary>
        /// <param name="kind">要数的种类。</param>
        /// <returns>该种类的格子数量。</returns>
        public int Count(CellKind kind)
        {
            int total = 0;
            for (int i = 0; i < cells.Length; i++)
            {
                if (cells[i] == kind)
                {
                    total++;
                }
            }

            return total;
        }

        private static uint NextState(uint state)
        {
            unchecked
            {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                return state;
            }
        }
    }
}
