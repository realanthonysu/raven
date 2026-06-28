/** 关于对话框 —— 应用名称、版本号、技术栈、许可证。 */

import { getVersion } from "@tauri-apps/api/app";
import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AboutCard() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("未知"));
  }, []);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Info className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Raven</p>
                <p className="text-sm text-muted-foreground">AI 驱动的英语学习桌面助手</p>
              </div>
            </div>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <Info className="h-4 w-4 mr-2" />
              版本信息
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>关于 Raven</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">应用名称</span>
              <span className="font-medium">Raven</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">版本号</span>
              <span className="font-medium">v{version}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">技术栈</span>
              <span className="font-medium">Tauri v2 + React 19</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">许可证</span>
              <span className="font-medium">MIT</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
