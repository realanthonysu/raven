/**
 * 文本模型设置卡片 —— 管理多个 OpenAI 兼容 API 的模型连接。
 *
 * 支持添加/删除/编辑/设为默认。默认模型被所有 LLM 页面使用。
 * 自行管理 models、form、editingModelId 等状态，仅通过 onError 向父级报告错误。
 */

import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { addModel, deleteModel, getModels, setDefaultModel, updateModel } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { smartFetch } from "@/lib/fetch-utils";
import type { ModelConfig } from "@/types";

interface ModelCardProps {
  onError: (msg: string) => void;
}

export function ModelCard({ onError }: ModelCardProps) {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [form, setForm] = useState({
    name: "",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    modelName: "",
    isDefault: false,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testError, setTestError] = useState("");

  useEffect(() => {
    getModels()
      .then(setModels)
      .catch((err) => console.warn("load models failed", err));
  }, []);

  async function handleAdd() {
    if (!form.name || !form.apiKey || !form.baseUrl || !form.modelName) return;
    try {
      await addModel({
        name: form.name,
        api_key: form.apiKey,
        base_url: form.baseUrl,
        model_name: form.modelName,
        is_default: models.length === 0,
      });
      setForm({
        name: "",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        modelName: "",
        isDefault: false,
      });
      setShowForm(false);
      getModels().then(setModels);
    } catch (err) {
      onError(`添加模型失败：${getErrorMessage(err)}`);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteModel(id);
      getModels().then(setModels);
    } catch (err) {
      onError(`删除模型失败：${getErrorMessage(err)}`);
    }
  }

  async function handleSetDefault(id: number) {
    try {
      await setDefaultModel(id);
      getModels().then(setModels);
    } catch (err) {
      onError(`设置默认模型失败：${getErrorMessage(err)}`);
    }
  }

  function handleEdit(model: ModelConfig) {
    setEditingId(model.id);
    setForm({
      name: model.name,
      apiKey: "",
      baseUrl: model.base_url,
      modelName: model.model_name,
      isDefault: model.is_default,
    });
  }

  async function handleUpdate() {
    if (editingId === null || !form.name || !form.baseUrl || !form.modelName) return;
    try {
      await updateModel(editingId, {
        name: form.name,
        base_url: form.baseUrl,
        model_name: form.modelName,
        api_key: form.apiKey,
        is_default: form.isDefault,
      });
      setEditingId(null);
      setForm({
        name: "",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        modelName: "",
        isDefault: false,
      });
      getModels().then(setModels);
    } catch (err) {
      onError(`更新模型失败：${getErrorMessage(err)}`);
    }
  }

  function resetForm() {
    setForm({
      name: "",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      modelName: "",
      isDefault: false,
    });
    setTestResult(null);
    setTestError("");
  }

  /** 测试 API 连接：发送一条简单的 chat completion 请求 */
  async function handleTestConnection() {
    if (!form.apiKey || !form.baseUrl || !form.modelName) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const url = `${form.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const response = await smartFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${form.apiKey}`,
        },
        body: JSON.stringify({
          model: form.modelName,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      const body = await response.json().catch(() => null);
      if (!body || !Array.isArray(body.choices)) {
        throw new Error("API 返回了非预期的响应格式，请检查模型名称是否正确。");
      }
      setTestResult("success");
    } catch (err) {
      setTestResult("error");
      setTestError(getErrorMessage(err, "连接失败"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>文本模型设置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 模型列表 */}
        {models.length > 0 && editingId === null && !showForm && (
          <>
            <div className="space-y-3">
              {models.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{model.name}</span>
                      {model.is_default && (
                        <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded">
                          默认
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {model.model_name} · {model.base_url}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleEdit(model)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={model.is_default}
                      onClick={() => handleSetDefault(model.id)}
                    >
                      设为默认
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(model.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-1" />
              添加新模型
            </Button>
          </>
        )}

        {/* 编辑/添加表单 */}
        {(models.length === 0 || editingId !== null || showForm) && (
          <>
            <Input
              placeholder="配置名称（如：Qwen、GPT-4）"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              placeholder={editingId !== null ? "API Key（留空则不修改）" : "API Key"}
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
            <Input
              placeholder="Base URL"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
            <Input
              placeholder="模型名称（如：qwen-plus、gpt-4）"
              value={form.modelName}
              onChange={(e) => setForm({ ...form, modelName: e.target.value })}
            />
            {editingId !== null && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch
                  checked={form.isDefault}
                  onCheckedChange={(v) => setForm({ ...form, isDefault: v })}
                />
                设为默认模型
              </label>
            )}
            <div className="flex gap-2 items-center flex-wrap">
              {editingId !== null ? (
                <>
                  <Button onClick={handleUpdate}>保存修改</Button>
                  <Button variant="outline" onClick={handleTestConnection} disabled={testing}>
                    {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    测试连接
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditingId(null);
                      resetForm();
                    }}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={handleAdd}>
                    <Plus className="h-4 w-4 mr-2" />
                    添加模型
                  </Button>
                  <Button variant="outline" onClick={handleTestConnection} disabled={testing}>
                    {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    测试连接
                  </Button>
                  {models.length > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setShowForm(false);
                        resetForm();
                      }}
                    >
                      取消
                    </Button>
                  )}
                </>
              )}
              {testResult === "success" && (
                <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" />
                  连接成功
                </span>
              )}
              {testResult === "error" && (
                <span className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                  <XCircle className="h-4 w-4" />
                  {testError || "连接失败"}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
