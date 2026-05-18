import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface ResultCardProps {
  title: string;
  icon?: ReactNode;
  variant?: "default" | "highlight" | "success";
  children: ReactNode;
}

const variantStyles = {
  default: "border-border",
  highlight: "border-primary/50",
  success: "border-green-500/50",
};

export function ResultCard({
  title,
  icon,
  variant = "default",
  children,
}: ResultCardProps) {
  return (
    <Card className={cn(variantStyles[variant])}>
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 text-sm leading-relaxed">
        {children}
      </CardContent>
    </Card>
  );
}
