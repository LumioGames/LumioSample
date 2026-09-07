using System;
using Lumio.Sample.Gameplay.Map;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests
{
    public sealed class MapLayoutTests
    {
        [Fact]
        public void 同种子两次生成逐格相同()
        {
            MapLayout first = MapLayout.Generate(new MapSettings(31, 31, 12345, 30));
            MapLayout second = MapLayout.Generate(new MapSettings(31, 31, 12345, 30));

            for (int z = 0; z < first.Depth; z++)
            {
                for (int x = 0; x < first.Width; x++)
                {
                    Assert.Equal(first.GetCell(x, z), second.GetCell(x, z));
                }
            }
        }

        [Fact]
        public void 不同种子生成不同布局()
        {
            MapLayout a = MapLayout.Generate(new MapSettings(31, 31, 1, 30));
            MapLayout b = MapLayout.Generate(new MapSettings(31, 31, 2, 30));

            bool anyDifference = false;
            for (int z = 0; z < a.Depth && !anyDifference; z++)
            {
                for (int x = 0; x < a.Width; x++)
                {
                    if (a.GetCell(x, z) != b.GetCell(x, z))
                    {
                        anyDifference = true;
                        break;
                    }
                }
            }

            Assert.True(anyDifference, "两个不同种子生成了完全相同的地图,随机源没起作用");
        }

        [Fact]
        public void 边界一圈全是硬墙()
        {
            MapLayout map = MapLayout.Generate(new MapSettings(21, 15, 7, 50));

            for (int x = 0; x < map.Width; x++)
            {
                Assert.Equal(CellKind.HardWall, map.GetCell(x, 0));
                Assert.Equal(CellKind.HardWall, map.GetCell(x, map.Depth - 1));
            }

            for (int z = 0; z < map.Depth; z++)
            {
                Assert.Equal(CellKind.HardWall, map.GetCell(0, z));
                Assert.Equal(CellKind.HardWall, map.GetCell(map.Width - 1, z));
            }
        }

        [Fact]
        public void 矿脉占比为零时没有矿脉()
        {
            MapLayout map = MapLayout.Generate(new MapSettings(21, 21, 99, 0));

            Assert.Equal(0, map.Count(CellKind.OreVein));
        }

        [Fact]
        public void 矿脉占比为一百时内部全是矿脉()
        {
            MapLayout map = MapLayout.Generate(new MapSettings(21, 21, 99, 100));

            int interior = (21 - 2) * (21 - 2);
            Assert.Equal(interior, map.Count(CellKind.OreVein));
            Assert.Equal(0, map.Count(CellKind.Floor));
        }

        [Fact]
        public void 种子为零也不退化()
        {
            // xorshift32 的状态一旦为 0 就永远是 0;实现里垫了非零常量,这里守住它。
            MapLayout map = MapLayout.Generate(new MapSettings(21, 21, 0, 50));

            Assert.True(map.Count(CellKind.OreVein) > 0, "种子 0 时随机源退化,整张图没有矿脉");
            Assert.True(map.Count(CellKind.Floor) > 0, "种子 0 时随机源退化,整张图没有地板");
        }

        [Theory]
        [InlineData(2, 10)]
        [InlineData(10, 2)]
        public void 尺寸太小时构造参数就报错(int width, int depth)
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new MapSettings(width, depth, 1, 10));
        }

        [Theory]
        [InlineData(-1)]
        [InlineData(101)]
        public void 矿脉占比越界时构造参数就报错(int oreVeinPercent)
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new MapSettings(21, 21, 1, oreVeinPercent));
        }

        [Fact]
        public void 读格子越界报错()
        {
            MapLayout map = MapLayout.Generate(new MapSettings(21, 21, 1, 10));

            Assert.Throws<ArgumentOutOfRangeException>(() => map.GetCell(-1, 0));
            Assert.Throws<ArgumentOutOfRangeException>(() => map.GetCell(0, 21));
        }

        [Fact]
        public void 参数为空时报错()
        {
            Assert.Throws<ArgumentNullException>(() => MapLayout.Generate(null!));
        }
    }
}
