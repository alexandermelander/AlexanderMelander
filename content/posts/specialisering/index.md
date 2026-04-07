---
title: "Inverse Kinematics using FABRIK"
date: 2026-04-06
summary: "Building a four-legged robotic spider that can walk on uneven surfaces using inverse kinematics in C++ by using F.A.B.R.I.K, an industry standard method implemented in engines such as Unreal and Unity."
coverImg: "header.png"
tags: ["C++", "Inverse Kinematics", "FABRIK", "Animation", "In-House Engine"]
---

## Overview

This post covers my journey in building a four-legged robotic spider that can walk on uneven surfaces using inverse kinematics in C++ by using F.A.B.R.I.K, an industry standard method implemented in engines such as Unreal and Unity.

<video autoplay muted loop playsinline preload="metadata" width="100%">
  <source src="Spider.mp4" type="video/mp4">
  Your browser does not support the video tag.
</video>
---

## Goal

The spider has several legs, and each leg should behave like a small chain of joints. The body needed to move independently, but the feet should remain planted on the terrain even at differing heights. 
To do that, I used FABRIK, which is a positional inverse kinematics solver, and is conceptually very simple and cheaper than alternatives.

---

## Building the Leg Chains

Each leg is represented as a set of joint indices from the skeleton. The last joint is the foot or end effector, which we will move to the target, then iteratively reposition the rest of the chain during backward and forward passes while preserving segment lengths.
But before running FABRIK, you need to convert the current animated pose into model space and then into world space so you can get a chain of actual positions. Luckily I was working in our own engine, which already had ways to store our skeleton and poses in our AnimatedModelComponents, so all I really had to change before I could get to work was to save away the default pose when it was missing animations and save it into a new struct **SpiderLegChain**. After that, I had a nice default pose to start working with.

{{% details summary="Show Leg Chain code" %}}
```cpp
    for (size_t legIndex = 0; legIndex < myLegChains.size(); ++legIndex)
    {
        SpiderLegChain& legChain = myLegChains[legIndex];

        IKChain originalChain = BuildIKChainFromLeg(legChain, referenceModelSpacePose);
        IKChain solvedChain   = originalChain;

        const Tga::Vector3f footTargetWorld = BuildFootTarget(legChain, originalChain, aDeltaTime, static_cast<int>(legIndex));

        //lift the middle joints before solving to bias FABRIK toward
        //a natural upward knee bend instead of collapsing underneath
        //for the scope of this project, it works in lieu of constraints!
        LiftChainForSolve(solvedChain, JOINT_Y_OFFSET, footTargetWorld);
        FABRIKSolver::Solve(solvedChain, footTargetWorld, MAX_ITERATIONS, TOLERANCE);
        ApplySolvedChainToPose(legChain, solvedChain, localPose);

#ifdef _DEBUG
        SpiderLegDebugDraw debugDrawData;
        debugDrawData.originalChain   = originalChain;
        debugDrawData.solvedChain     = solvedChain;
        debugDrawData.footTargetWorld = footTargetWorld;
        myDebugLegDrawData.push_back(debugDrawData);
#endif

        //update modelSpacePose after each leg so the next leg's ApplySolvedChainToPose
        //reads parent rotations that already include the previous leg's contribution
        mySkeleton->ConvertPoseToModelSpace(localPose, modelSpacePose);
    }
```
{{% /details %}}

{{% details summary="Show Foot Target code" %}}
```cpp
Tga::Vector3f Spider::BuildFootTarget(SpiderLegChain& aLegChain, const IKChain& aChain) const
{
    auto& navMesh = Singletons::GetLevelHandler().GetActiveLevel()->GetNavmesh();
    const Tga::Matrix4x4f& spiderWorldTransform = myAnimatedModel->GetTransform();

    if (!aLegChain.hasPlantedFootTarget)
    {
        const Tga::Vector3f footWorldPosition = aChain.jointPositionsWorld.back();

        aLegChain.restOffsetLocalSpace = WorldToLocalPoint(spiderWorldTransform, footWorldPosition);

        aLegChain.plantedFootTargetWorld = footWorldPosition;
        aLegChain.plantedFootTargetWorld.y = navMesh.GetHeightOfPoint(aLegChain.plantedFootTargetWorld);
        aLegChain.hasPlantedFootTarget = true;

        return aLegChain.plantedFootTargetWorld;
    }

    const Tga::Vector3f naturalFootPositionWorld = LocalToWorldPoint(spiderWorldTransform, aLegChain.restOffsetLocalSpace);
    Tga::Vector3f desiredStepTargetWorld = naturalFootPositionWorld;
    desiredStepTargetWorld.y = navMesh.GetHeightOfPoint(desiredStepTargetWorld);

    aLegChain.plantedFootTargetWorld.y = navMesh.GetHeightOfPoint(aLegChain.plantedFootTargetWorld);

    const float distanceFromNaturalToPlanted = (aLegChain.plantedFootTargetWorld - desiredStepTargetWorld).Length();
    const float maxDriftBeforeStep = 20.0f;
    if (distanceFromNaturalToPlanted > maxDriftBeforeStep)
    {
        aLegChain.plantedFootTargetWorld = desiredStepTargetWorld;
    }

    return aLegChain.plantedFootTargetWorld;
}
```
{{% /details %}}
---

## Solving with FABRIK
At this point, things are still relative simple. Taking one leg at a time, we convert what we've stored from the spider into a generic IKChain which holds the joints position and lengths, and total length of the chain.
Extremely short and sweet. And after population the new IKChain, we have everything to sovle it!

The first thing the solver does is handle the simplest edge case, which is when the target is too far away to ever be reached. If the distance from the root joint to the target is greater than the total length of the chain, then there is no fancy solution to find. The only thing the leg can do is stretch itself out as far as possible in the direction of the target.

The solve works in two passes that repeat over and over until the foot is close enough to the target. The end effector is snapped directly onto the target, because that is ultimately where we want the chain to end. Then the solver walks backward through the leg, moving each earlier joint so that it stays the correct distance away from its child.

The backward pass gets the foot where it should go, but it can pull the root away from where it belongs. Since the root joint is supposed to stay anchored to the spider’s body, the solver now snaps the root back to its original position and walks forward through the chain again. This time, each child joint is repositioned so that every segment length is preserved from the root outward.

{{% details summary="Show FABRIK solve code" %}}
```cpp
bool FABRIKSolver::Solve(IKChain& aChain, const Tga::Vector3f& aTargetWorld, int aMaxIterations, float aTolerance)
{
    const int jointCount = static_cast<int>(aChain.jointPositionsWorld.size());
    if (jointCount < 2)
    {
        return false;
    }

    const Tga::Vector3f originalRootPosition = aChain.jointPositionsWorld.front();
    const float distanceFromRootToTarget = Length(aTargetWorld - originalRootPosition);

    if (distanceFromRootToTarget > aChain.totalLength)
    {
        for (int jointIndex = 0; jointIndex < jointCount - 1; ++jointIndex)
        {
            const Tga::Vector3f& currentJointPosition = aChain.jointPositionsWorld[jointIndex];
            const float segmentLength = aChain.segmentLengths[jointIndex];
            const Tga::Vector3f directionToTarget = NormalizeSafe(aTargetWorld - currentJointPosition);
            aChain.jointPositionsWorld[jointIndex + 1] = currentJointPosition + directionToTarget * segmentLength;
        }

        return true;
    }

    for (int iteration = 0; iteration < aMaxIterations; ++iteration)
    {
        aChain.jointPositionsWorld.back() = aTargetWorld;

        for (int jointIndex = jointCount - 2; jointIndex >= 0; --jointIndex)
        {
            const float segmentLength = aChain.segmentLengths[jointIndex];
            aChain.jointPositionsWorld[jointIndex] = MoveToDistance(aChain.jointPositionsWorld[jointIndex + 1], aChain.jointPositionsWorld[jointIndex], segmentLength);
        }

        aChain.jointPositionsWorld.front() = originalRootPosition;

        for (int jointIndex = 0; jointIndex < jointCount - 1; ++jointIndex)
        {
            const float segmentLength = aChain.segmentLengths[jointIndex];
            aChain.jointPositionsWorld[jointIndex + 1] = MoveToDistance(aChain.jointPositionsWorld[jointIndex], aChain.jointPositionsWorld[jointIndex + 1], segmentLength);
        }

        const float remainingDistance = Length(aTargetWorld - aChain.jointPositionsWorld.back());
        if (remainingDistance <= aTolerance)
        {
            return true;
        }
    }

    return true;
}
```
{{% /details %}}

At the end of each iteration, the solver checks how far the end effector still is from the target. If that remaining distance is smaller than the tolerance, then the solve stops early because the result is already good enough.

With this data we can now visualize the spiders bones and joints by drawing them out. To help me along the way I wanted two things: A way to visualize the pre-solved joints joints, and the solved one, and a way to pause and step through each iteration of the Spider moving. With these two simple but invaluable debug it became much easier to digest the problems that began to appear.

![Image](bentspider.png)

...Well, that doesn't look right!

---

## Rebuilding the Mesh

The most important realization of the project came after the green debug lines, representing the solved FABRIK chain, finally started looking correct. I had assumed that once FABRIK produced a clean solution, the mesh would just follow automatically. That assumption was completely wrong, and honestly pretty naive.

The green line is only a chain of solved positions in space. The mesh, however, is driven by bone transforms, which means it needs correct rotations as well. That sounds like a tiny distinction at first, but it completely changes the problem. It also forced me to confront the fact that my understanding of animation had mostly been at the surface level up until that point. From there on, the challenge was no longer getting FABRIK to solve a nice chain, but figuring out how to make the actual rig follow that solution without tearing itself apart.

{{% details summary="Show Pose code" %}}
```cpp
void Spider::ApplySolvedChainToPose(const SpiderLegChain& aLegChain, const IKChain& aSolvedChain, Tga::LocalSpacePose& aLocalPose) const
{
    Tga::ModelSpacePose currentModelSpacePose{};
    mySkeleton->ConvertPoseToModelSpace(aLocalPose, currentModelSpacePose);

    const Tga::Matrix4x4f spiderWorldTransform = myAnimatedModel->GetTransform();

    for (size_t chainJointIndex = 0; chainJointIndex + 1 < aLegChain.jointIndices.size(); ++chainJointIndex)
    {
        const int currentSkeletonJointIndex = aLegChain.jointIndices[chainJointIndex];
        const int childSkeletonJointIndex = aLegChain.jointIndices[chainJointIndex + 1];
        const int parentSkeletonJointIndex = mySkeleton->Joints[currentSkeletonJointIndex].Parent;

        Tga::Vector3f currentDirectionWorld = GetJointWorldPosition(currentModelSpacePose, childSkeletonJointIndex) - GetJointWorldPosition(currentModelSpacePose, currentSkeletonJointIndex);
        Tga::Vector3f solvedDirectionWorld = aSolvedChain.jointPositionsWorld[chainJointIndex + 1] - aSolvedChain.jointPositionsWorld[chainJointIndex];

        if (currentDirectionWorld.LengthSqr() <= 0.0001f || solvedDirectionWorld.LengthSqr() <= 0.0001f)
        {
            continue;
        }

        currentDirectionWorld.Normalize();
        solvedDirectionWorld.Normalize();

        //figure out how far the joint needs to rotate to match the solved direction
        const Tga::Quaternionf worldDeltaRotation = Tga::Quaternionf::CreateFromTo(currentDirectionWorld, solvedDirectionWorld);

        //model space accumulates the full parent chain, so the model space rotation
        //of the parent IS its world rotation when the spider itself has no rotation.
        //for the root joint there is no skeleton parent, so the spider world transform is the parent
        const Tga::Quaternionf parentWorldRotation = (parentSkeletonJointIndex >= 0)
            ? currentModelSpacePose.JointTransforms[parentSkeletonJointIndex].GetRotationAsQuaternion()
            : spiderWorldTransform.GetRotationAsQuaternion();

        const Tga::Quaternionf parentWorldRotationInverse = parentWorldRotation.GetConjugate().GetNormalized();

        //row-vector sandwich to convert the world delta into local space:
        //q_parent * worldDelta * inv(q_parent)
        const Tga::Quaternionf localDeltaRotation = parentWorldRotation * worldDeltaRotation * parentWorldRotationInverse;

        Tga::ScaleRotationTranslationf& jointLocalTransform = aLocalPose.JointTransforms[currentSkeletonJointIndex];

        //row-vector convention applies delta on the right: old * localDelta
        jointLocalTransform.SetRotation((jointLocalTransform.GetRotation() * localDeltaRotation).GetNormalized());

        //reconvert after each joint so the next joint reads correct parent transforms
        mySkeleton->ConvertPoseToModelSpace(aLocalPose, currentModelSpacePose);
    }
}
```
{{% /details %}}

I was applying each new IK solution on top of the previous frame's already modified pose, which meant the values kept accumulating and mutating further and further away from the original skeleton. That was why the spider would eventually bend into absurd shapes, why the joint rotations spiraled out of control, and why parts of the leg sometimes looked like they were completely disconnecting from one another.

The fix was to cache the original clean pose and restart from that every frame before applying IK. As soon as I did that, the result became dramatically more stable. That did not solve every remaining issue with reconstruction or rotation, but it removed the feedback loop that had been corrupting the entire leg system over time. Once that was under control, I could finally move on to the more interesting part, which was improving how the spider actually stepped and moved across the terrain.

It was mostly cleaning up magic numbers and tweaking tolerances, speeds, and other values I had already established, and adding leg groups so the spider would walk "realistically", meaning one front and one back leg at a time. Which lead the result you saw above.

<video controls preload="metadata" width="100%">
  <source src="Spider.mp4" type="video/mp4">
  Your browser does not support the video tag.
</video>

This satisfied my curiosity of how inverse kinematics were applied in games. FABRIK seems to be the most popular implementation overall, with Unreal and Unity both having some form of it, most likely to its low computotional cost. Even though the course is finished and I have to turn in this assignment, I'll be continuing to work on this implementation and hopefully see it in our final project. Now that I've gotten a taste of it I want to see where we can start using it, and I have no shortage of ideas. I'll most likely be updating this with any improvements or additions once I get to that point.