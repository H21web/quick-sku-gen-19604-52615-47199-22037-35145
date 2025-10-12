# Vercel Deployment Guide - Barcode Generator

This guide will walk you through deploying your Barcode Generator app to Vercel.

## Prerequisites

1. A [GitHub](https://github.com) account
2. A [Vercel](https://vercel.com) account (free tier is fine)
3. Your project code in a GitHub repository

## Step 1: Push Your Code to GitHub

If you haven't already:

```bash
# Initialize git repository (if not done)
git init

# Add all files
git add .

# Commit changes
git commit -m "Initial commit - Barcode Generator"

# Create a new repository on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

## Step 2: Connect to Vercel

1. Go to [https://vercel.com](https://vercel.com)
2. Click "Sign Up" or "Log In" (use your GitHub account)
3. Click "New Project" or "Add New..." → "Project"
4. Import your GitHub repository:
   - Click "Import Git Repository"
   - Select your repository from the list
   - Click "Import"

## Step 3: Configure Environment Variables

In the Vercel project configuration page:

1. Scroll down to "Environment Variables" section
2. Add the following variables:

### Items Configuration
- **Name:** `VITE_ITEMS`
- **Value:** `Onion:59019620|Potato:59019621|Tomato:59019622`

Click "Add"

### Quantities Configuration
- **Name:** `VITE_QUANTITIES`
- **Value:** `200g:050201|500g:050501|750g:050751|1kg:051001|2kg:052001|3kg:053001|5kg:055001`

Click "Add"

### Quick Select Presets
- **Name:** `VITE_QUICK_SELECT`
- **Value:** `0,3|1,3|0,1|2,4`

Click "Add"

> **Note:** These are the default values. Customize them based on your needs.

## Step 4: Deploy

1. After adding environment variables, click "Deploy"
2. Vercel will automatically:
   - Install dependencies
   - Build your project
   - Deploy to production
3. Wait for the build to complete (usually 1-2 minutes)

## Step 5: Access Your App

Once deployed:
- Your app will be live at: `https://YOUR_PROJECT_NAME.vercel.app`
- Vercel provides automatic HTTPS
- Every push to your main branch will trigger a new deployment

## Customizing Your Configuration

### Format Guide for Environment Variables

#### VITE_ITEMS Format
```
ItemName1:SerialID1|ItemName2:SerialID2|ItemName3:SerialID3
```
Example:
```
Apple:59019623|Banana:59019624|Orange:59019625
```

#### VITE_QUANTITIES Format
```
Quantity1:SerialID1|Quantity2:SerialID2
```
Example:
```
100g:050101|250g:050251|1.5kg:051501
```

#### VITE_QUICK_SELECT Format
```
itemIndex,quantityIndex|itemIndex,quantityIndex
```
- Indexes are 0-based (first item = 0, second = 1, etc.)
- Example: `0,3` means first item with fourth quantity

Example:
```
0,0|1,1|2,2|0,3
```

### Updating Environment Variables

1. Go to your project dashboard on Vercel
2. Click "Settings" tab
3. Click "Environment Variables" in the sidebar
4. Edit, add, or remove variables
5. Click "Save"
6. Redeploy your app (Settings → Deployments → click "..." → Redeploy)

## Custom Domain (Optional)

To use your own domain:

1. Go to your project on Vercel
2. Click "Settings" → "Domains"
3. Add your domain
4. Follow Vercel's instructions to update your DNS records

## Troubleshooting

### Build Fails
- Check the build logs in Vercel dashboard
- Ensure all dependencies are in package.json
- Verify environment variables are set correctly

### App Doesn't Load Items
- Check environment variables are set in Vercel
- Verify the format is correct (use | as separator, : for name:serialId)
- Check browser console for errors

### Changes Not Appearing
- Vercel caches aggressively. Clear your browser cache or use incognito mode
- Check that your git push was successful
- Verify the deployment completed in Vercel dashboard

## Automatic Deployments

Every time you push to your GitHub repository:
- Vercel automatically detects the change
- Builds and deploys the new version
- Updates your production site in 1-2 minutes

## Production URLs

After deployment, you'll have:
- **Production URL:** `https://YOUR_PROJECT_NAME.vercel.app`
- **Preview URLs:** Generated for every branch/PR (great for testing)

## Performance Tips

Your app is already optimized for production with:
- Vite's automatic code splitting
- Optimized bundle sizes
- Fast global CDN delivery via Vercel
- Automatic HTTPS
- Optimized caching

## Support

For Vercel-specific issues:
- [Vercel Documentation](https://vercel.com/docs)
- [Vercel Support](https://vercel.com/support)

For app issues:
- Check browser console for errors
- Verify environment variables match the expected format
