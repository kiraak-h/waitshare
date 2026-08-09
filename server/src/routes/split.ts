import { Router } from "express"
import { getSplitContract } from "../services/split.js"
import { asyncHandler } from "../async-handler.js"

export const splitRouter = Router()

splitRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const split = await getSplitContract()
    res.json({ split, formula: "dev_share = floor(gross * dev_share / 100)" })
  })
)
