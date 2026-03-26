import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

/**
 * Zod schema defining the strict output structure expected from the LLM parser.
 */
export const applicationSchema = z.object({
  company: z.string().describe("The name of the company or institution."),
  role: z.string().optional().describe("Job title, program name, or role applied for. Default to the closest guess if missing."),
  status: z.enum(["APPLIED", "UPDATED", "ASSESSMENT", "INTERVIEW_REQUESTED", "INTERVIEW", "OFFER", "REJECTED"])
    .describe("Determine the closest match for the application status. Use UPDATED if they just need more info, ASSESSMENT if requesting a test/take-home."),
  nextSteps: z.string().optional().describe("A brief summary of what the applicant must do next, e.g., 'Reply with availability' or 'Fill out the background check'."),
  extractedDates: z.array(z.string()).optional().describe("Any distinct dates, times, or deadlines mentioned. Preserve original timezone logic if provided.")
});

/**
 * Feed the raw email subject and body into Gemini 3.0 Flash to rapidly extract the canonical variables
 * necessary for the mission-control dashboard.
 */
export async function parseApplicationEmail(emailContent: string, subject: string) {
  const result = await generateObject({
    model: google("gemini-3.0-flash"), // Utilizes the newest Flash architecture for extremely rapid extraction
    schema: applicationSchema,
    prompt: `Analyze the following email regarding an application:
    
    Subject: ${subject}
    Email Body:
    ${emailContent}
    
    Extract the company name, role, current application status, any immediate next steps, and any critical dates/deadlines.`
  });

  return result.object;
}
