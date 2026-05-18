import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";
import { getModels, addModel, deleteModel } from "@/lib/model-storage";
import type { ModelConfig } from "@/types";

export default function SettingsPage() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [form, setForm] = useState({
    name: "",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    modelName: "",
  });

  useEffect(() => {
    setModels(getModels());
  }, []);

  function handleAdd() {
    if (!form.name || !form.apiKey || !form.baseUrl || !form.modelName) return;
    addModel({
      name: form.name,
      api_key: form.apiKey,
      base_url: form.baseUrl,
      model_name: form.modelName,
      is_default: models.length === 0,
    });
    setForm({ name: "", apiKey: "", baseUrl: "https://api.openai.com/v1", modelName: "" });
    setModels(getModels());
  }

  function handleDelete(id: number) {
    deleteModel(id);
    setModels(getModels());
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold">设置</h2>

      <Card>
        <CardHeader>
          <CardTitle>添加模型配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="配置名称（如：Qwen、GPT-4）"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            placeholder="API Key"
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
          <Button onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-2" />
            添加模型
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已保存的模型</CardTitle>
        </CardHeader>
        <CardContent>
          {models.length === 0 ? (
            <p className="text-muted-foreground text-sm">暂无模型配置，请先添加。</p>
          ) : (
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
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(model.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
