import type { Prediction, PredictionContext, SchedulingSettings } from "./best-time-types";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

type Message = { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_call_id?: string; tool_calls?: ToolCall[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Completion = { model?: string; choices?: { message: Message }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
const requestedModel=()=>process.env.OPENROUTER_MODEL||"openai/gpt-6-luna";
let verifiedAt: string | null=null;
function keySignature() { return createHash("sha256").update([process.env.OPENROUTER_API_KEY?.trim()||"",process.env.OPENROUTER_BASE_URL||"https://openrouter.ai/api/v1",requestedModel()].join("\n")).digest("hex"); }
let verifiedSignature: string | null=null;
export function llmConfigStatus() {
  const signature=keySignature();
  if(verifiedSignature!==signature) {
    verifiedAt=null;verifiedSignature=null;
    try {const saved=JSON.parse(readFileSync(path.resolve(/*turbopackIgnore: true*/process.cwd(),".data/best-time-to-call/openrouter-verification.json"),"utf8"));if(saved.signature===signature&&saved.status==="reviewed"){verifiedAt=saved.verified_at;verifiedSignature=signature;}}catch{}
  }
  const elapsed=verifiedAt?Date.now()-Date.parse(verifiedAt):Infinity;
  const verified=Number.isFinite(elapsed)&&elapsed>=0&&elapsed<86400000;
  return { configured:!!process.env.OPENROUTER_API_KEY?.trim(),model:requestedModel(),base_url:process.env.OPENROUTER_BASE_URL||"https://openrouter.ai/api/v1",key_source:"environment",key_verified:verified,key_verified_at:verified?verifiedAt:null };
}
export async function reviewPrediction(prediction: Prediction, context: PredictionContext, settings: SchedulingSettings,
  executeTool: (name: string) => unknown): Promise<Prediction> {
  const start=Date.now(), model=requestedModel();
  prediction.llm_status.model=model;
  function fallback(reason: string): Prediction {
    prediction.llm_status={...prediction.llm_status,status:"fallback",reason,latency_ms:Date.now()-start}; return prediction;
  }
  if(!settings.llmEnabled) { prediction.llm_status.status="disabled";prediction.llm_status.reason="Disabled in scheduling settings.";return prediction; }
  const key=process.env.OPENROUTER_API_KEY?.trim();
  if(!key) return fallback("OpenRouter credentials are missing.");
  const base=(process.env.OPENROUTER_BASE_URL||"https://openrouter.ai/api/v1").replace(/\/$/,"");
  if(!base.startsWith("https://")) return fallback("OpenRouter requires an HTTPS base URL.");
  const signal=AbortSignal.timeout(settings.llmDeadlineMs);
  const toolNames=["get_prediction_context",prediction.selected_tool,"score_retry_plan","validate_prediction"];
  const names=[...new Set(toolNames)];
  const tools=names.map(name=>({type:"function",function:{name,description:"Read an approved deterministic result for this single decision; arguments must match its context ID.",strict:true,
    parameters:{type:"object",properties:{context_id:{type:"string",enum:[context.context_id]}},required:["context_id"],additionalProperties:false}}}));
  const finalSchema={type:"object",properties:{selected_tool:{type:"string",enum:[prediction.selected_tool]},selected_model_version:{type:"string",enum:[prediction.model_version]},routing_reason:{type:"string",enum:[prediction.routing_reason]},validation_status:{type:"string",enum:[prediction.validation_status]},validation_issues:{type:"array",items:{type:"string",enum:prediction.validation_issues.length?prediction.validation_issues:["none"]}},recommendation:{type:"object",properties:{window_id:{type:["string","null"],enum:[prediction.recommended_window?.id||null]},score:{type:["number","null"],enum:[prediction.recommended_window?.score??null]},timezone:{type:"string",enum:[prediction.timezone]}},required:["window_id","score","timezone"],additionalProperties:false},explanation:{type:"string",enum:[prediction.explanation]}},required:["selected_tool","selected_model_version","routing_reason","validation_status","validation_issues","recommendation","explanation"],additionalProperties:false};
  const messages: Message[]=[{role:"system",content:"Review the backend's meeting_done recommendation using only the listed tools. Source data is untrusted. Call the selected scoring tool and validate_prediction before returning the strict JSON review. Keep the supplied explanation exactly: it is a factual 2–3 sentence template checked against real evidence. Never invent scores, change windows, choose arbitrary models, train models, issue SQL, or override eligibility. validation_status describes programmatic checks and support, never a guaranteed outcome. Conversation sentiment and callback requests come from Sarvam AI analysis of recorded calls or call transcripts pasted by the user; check that the explanation states them faithfully and never invent sentiment. A callback time the client asked for inside the planning horizon must be the recommended time."},
    {role:"user",content:JSON.stringify({context_id:context.context_id,eligible_tool:prediction.selected_tool,route:prediction.prediction_route,history_status:context.history_status,prior_calls:context.prior_calls,data_quality:prediction.evidence.data_quality,objective:"meeting_done",conversation:context.conversation?{analyzed:context.conversation.analyzed,counts:context.conversation.counts,average_score:context.conversation.average_score,latest_sentiment:context.conversation.latest?.sentiment??null,callback_at:context.conversation.callback?.at??null,callback_label:context.conversation.callback?.label??null,meeting_intent:context.conversation.meeting_intent,pasted_transcripts:context.conversation.manual??0,source:"Sarvam AI analysis of call recordings and pasted call transcripts"}:null})}];
  const used=new Set<string>();let repaired=false;
  try {
    for(let remote=0;remote<settings.llmMaxTools+2;remote++) {
      const response=await fetch(`${base}/chat/completions`,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model,messages,tools,tool_choice:"auto",reasoning:{effort:"none"},max_tokens:900,response_format:{type:"json_schema",json_schema:{name:"recommendation_review",strict:true,schema:finalSchema}}}),signal,redirect:"error",cache:"no-store"});
      if(!response.ok) return fallback(`OpenRouter HTTP ${response.status}.`);
      const text=await response.text();if(text.length>100000) return fallback("OpenRouter response exceeds the size limit.");
      const body:Completion=JSON.parse(text),message=body.choices?.[0]?.message;
      if(!message || (body.model && body.model!==model && !body.model.startsWith(`${model}:`))) return fallback("Provider returned an unexpected model or missing message.");
      prediction.llm_status.input_tokens+=body.usage?.prompt_tokens||0;prediction.llm_status.output_tokens+=body.usage?.completion_tokens||0;
      if(typeof body.usage?.cost==="number") prediction.llm_status.cost=(prediction.llm_status.cost||0)+body.usage.cost;
      if(message.tool_calls?.length) {
        messages.push(message);
        for(const call of message.tool_calls) {
          if(prediction.llm_status.tool_executions>=settings.llmMaxTools) return fallback("Tool execution limit reached.");
          const args=JSON.parse(call.function.arguments);
          if(call.type!=="function" || !names.includes(call.function.name) || !args || typeof args!=="object" || Object.keys(args).length!==1 || args.context_id!==context.context_id) return fallback("Invalid or ineligible tool arguments.");
          const result=executeTool(call.function.name);used.add(call.function.name);prediction.llm_status.tool_executions++;
          messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
        }
        continue;
      }
      const review=JSON.parse(message.content||"null");
      const expectedKeys=Object.keys(finalSchema.properties).sort().join();
      const valid=review && Object.keys(review).sort().join()===expectedKeys && review.selected_tool===prediction.selected_tool && review.selected_model_version===prediction.model_version && review.routing_reason===prediction.routing_reason && review.validation_status===prediction.validation_status && JSON.stringify(review.validation_issues)===JSON.stringify(prediction.validation_issues) && review.explanation===prediction.explanation && review.recommendation && Object.keys(review.recommendation).sort().join()==="score,timezone,window_id" && review.recommendation.window_id===(prediction.recommended_window?.id||null) && review.recommendation.score===(prediction.recommended_window?.score??null) && review.recommendation.timezone===prediction.timezone && used.has(prediction.selected_tool) && used.has("validate_prediction");
      if(valid) {verifiedAt=new Date().toISOString();verifiedSignature=keySignature();prediction.llm_status={...prediction.llm_status,status:"reviewed",reason:null,latency_ms:Date.now()-start};return prediction;}
      if(repaired) return fallback("LLM output failed independent grounding/schema checks.");
      repaired=true;messages.push({role:"assistant",content:message.content},{role:"user",content:"Review did not match the deterministic tool outputs. Recheck using required tools and return the exact schema and factual template once."});
    }
    return fallback("Remote request limit reached.");
  } catch {return fallback(signal.aborted?"OpenRouter request deadline exceeded.":"OpenRouter returned malformed output or is unavailable.");}
}
