import { Router } from "express"
import { getSplitContract } from "../services/split.js"

export const splitRouter = Router()

splitRouter.get("/", (_req, res) => {
  res.json({ split: getSplitContract(), formula: "dev_share = floor(gross * dev_share / 100)" })
})
