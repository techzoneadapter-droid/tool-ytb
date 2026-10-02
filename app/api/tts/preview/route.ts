import { NextRequest } from "next/server";
import { ttsRequest } from "@/modules/tts/http";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  return ttsRequest(req, true);
}
