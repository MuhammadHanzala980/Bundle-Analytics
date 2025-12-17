import { NextResponse } from "next/server";

export async function POST(request) {
  try {
    const { reviewId, reply, adminName } = await request.json();
    
    const wpUrl = "https://microdosify.com/wp-json/wp/v2";
    // Credentials
    const authString = "hanzala:HetJ QF8J Q6Xe UL1N 1c1w VVgf";
    const authHeader = `Basic ${Buffer.from(authString).toString("base64")}`;

    // Admin Email (Zaroori hai validation pass karne ke liye)
    // Aap yahan apni asli admin email use kar sakte hain
    const adminEmail = "muhammadhanzala980@gmail.com"; 

    if (!reviewId || !reply) {
      return NextResponse.json(
        { success: false, message: "Review ID and Reply are required" },
        { status: 400 }
      );
    }

    // 1. Parent Comment Fetch karein (Post ID lene ke liye)
    const parentResponse = await fetch(`${wpUrl}/comments/${reviewId}`, {
      method: "GET",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
    });

    if (!parentResponse.ok) {
      throw new Error("Parent comment not found");
    }

    const parentData = await parentResponse.json();
    const postId = parentData.post;
    const existingReplies = parentData.replies || [];

    // 2. Reply Post karein (Fixed Payload)
    const replyResponse = await fetch(`${wpUrl}/comments`, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post: postId,
        parent: reviewId,
        content: reply,
        status: "approved",
        // ERROR FIX: Name ke sath Email bhejna lazmi hai
        author_name: adminName || "Microdosify Team", 
        author_email: adminEmail, 
        // Optional: Admin ki website ka link
        author_url: "https://microdosify.com" 
      }),
    });

    const newReplyData = await replyResponse.json();

    if (!replyResponse.ok) {
      // Agar ab bhi error aaye toh WordPress ka exact message throw karein
      throw new Error(newReplyData.message || newReplyData.code || "Failed to post reply");
    }

    // 3. Response Return karein
    const updatedReplies = [...existingReplies, newReplyData];

    return NextResponse.json({
      success: true,
      updatedReview: {
        id: reviewId,
        meta: {
          mostHelpful: parentData.meta?.mostHelpful || false,
          replies: updatedReplies
        }
      }
    });

  } catch (error) {
    console.error("Reply API Error:", error);
    return NextResponse.json(
      { success: false, message: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}