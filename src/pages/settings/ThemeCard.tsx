/** 外观设置卡片 —— 浅色/深色/跟随系统主题切换。 */

import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type Theme, useTheme } from "@/hooks/use-theme";

export function ThemeCard() {
  const { theme, setTheme } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-5 w-5" />
          外观
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          {(
            [
              { label: "浅色", value: "light" },
              { label: "深色", value: "dark" },
              { label: "跟随系统", value: "system" },
            ] as { label: string; value: Theme }[]
          ).map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={theme === opt.value ? "default" : "outline"}
              onClick={() => setTheme(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
