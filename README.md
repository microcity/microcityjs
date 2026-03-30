# 文档驱动仿真（Document-Driven Simulation）框架
本仓库是文档驱动仿真框架的示例

## 文件结构
```text
dds/
├─ index.html          # 用户界面与交互入口
├─ docs/
│  ├─ tech_spec.md     # 技术说明（底层架构与接口）
|  ├─ sim_logic.md	   # 仿真逻辑（业务模型与规则）
|  └─ scene_set.md	   # 场景设置（案例模块与细节）
├─ code/               # 代码目录
└─ data/               # 数据目录
```

## 使用方法
Chat AI提示词：
1. 根据/docs/tech_spec.md创建代码文件及底层框架
2. 根据/docs/sim_logic.md构建仿真基础框架
3. 根据/docs/scene_set.md构建仿真案例场景
