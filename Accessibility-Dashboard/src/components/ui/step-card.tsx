"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StepCardProps {
  onComplete?: (data: { email: string }) => void | Promise<void>;
  isSubmitting?: boolean;
}

export default function StepCard({ onComplete, isSubmitting = false }: StepCardProps) {
  const [email, setEmail] = React.useState("");

  const handleSubmit = async () => {
    if (onComplete) {
      await onComplete({ email });
    }
  };

  return (
    <div className="flex items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <h2 className="mb-6 text-center text-2xl font-semibold text-slate-900">로그인</h2>

        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="email">이메일</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button onClick={handleSubmit} className="mt-4 w-full" disabled={isSubmitting || email.trim().length === 0}>
            {isSubmitting ? "확인 중..." : "로그인"}
          </Button>
        </div>
      </div>
    </div>
  );
}
