# 操作说明

## 修改全局设定

修改 `baize/config/global.md` 和 `baize/config/global.yaml`。涉及身份、语言、权限边界的修改必须经过确认。

## 添加记忆

短事实写入 `baize/memory/shallow/`。大文件放入 `baize/memory/deep/partitions/` 对应分类，并更新 `baize/memory/deep/indexes/` 中的索引。

## 添加逻辑

人类可读断言写入 `baize/logic/assertions/`。可执行规则写入 `baize/logic/executable/`。

## 添加插件

在 `baize/skills/` 下创建插件目录，并更新 `baize/skills/registry.yaml`。
