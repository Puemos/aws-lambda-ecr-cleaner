const Promise = require('bluebird')
const R = require('ramda')
const debug = require('debug')('aws-lambda-ecr-cleaner:Api')

const utils = require('./utils')

/**
 *
 *
 * @param {Config} config Global config object
 * @param {AWS.ECR} ecr ECR API
 * @returns {Promise<AWS.ECR.ImageIdentifierList>}
 */
const getRepoImages = (config, ecr) => {
  const listImages = utils.withNextToken(ecr.listImages, 'imageIds', {
    repositoryName: config.REPO_TO_CLEAN
  })
  return listImages([])
}

/**
 * Takes an argument of an array of full image definitions
 * and splits into tags to delete from the REPO_TO_CLEAN repo
 *
 * @param {Config} config Global config object
 * @param {AWS.ECR} ecr ECR API
 * @param {AWS.ECR.ImageIdentifierList} images Array of images names to be deleted
 * @returns {Promise<AWS.ECR.ImageIdentifierList>}
 */
const deleteImages = (config, ecr, images) => {
  const batchImages = R.splitEvery(99, images)
  return Promise.map(
    batchImages,
    imagesChunk =>
      new Promise(resolve => {
        debug('IMAGES TO DELETE:', imagesChunk)
        const imageTagsToDelete = imagesChunk.map(image => ({
          imageTag: image.split(':')[1]
        }))

        debug('IMAGE TAGS TO DELETE:', imageTagsToDelete)

        // Make sure we are doing this for real
        if (config.DRY_RUN || R.isEmpty(imageTagsToDelete)) {
          resolve({
            failures: [],
            success: [],
            count: 0
          })
        }

        const params = {
          imageIds: imageTagsToDelete,
          repositoryName: config.REPO_TO_CLEAN
        }

        // Batch delete all images in the deletionQueue
        return ecr
          .batchDeleteImage(params)
          .promise()
          .then(deletions => {
            resolve({
              failures: deletions.failures,
              success: deletions.imageIds,
              count: R.keys(deletions.imageIds).length
            })
          })
      })
  ).then(batchResolts => {
    return batchResolts.reduce(
      (all, curr) => ({
        failures: [].concat(all.failures).concat(curr.failures),
        success: [].concat(all.success).concat(curr.success),
        count: all.count + curr.count
      }),
      { failures: [], success: [], count: 0 }
    )
  })
}

/**
 * Goes through all of ECS in a particular region and determines what is still
 * marked as active and in use containers at a Task level (not actual running tasks)
 * 
 * @param {Config} config Global config object 
 * @param {AWS.ECS} ecs ECS API
 * @param {Array<AWS.ECS.TaskDefinition>} taskDefs Array of images to be filtered by active
 * @returns {Promise<AWS.ECR.ImageIdentifierList>}
 */
const getAllImagesTagsByTaskDef = R.curry(
  (config, ecs, taskDefinitionArns) =>
    new Promise(resolve => {
      Promise.map(taskDefinitionArns, taskDefinitionARN =>
        // Get all active images from all container defintions
        ecs
          .describeTaskDefinition({ taskDefinition: taskDefinitionARN })
          .promise()
          .tap(() => Promise.delay(config.API_DELAY))
          .then(R.pathOr([], ['taskDefinition', 'containerDefinitions']))
          .then(containerDefinitions => containerDefinitions.map(R.prop('image')))
          .then(resolve)
      )
    })
)

/**
 * Goes through all of ECS in a particular region and determines what is still
 * marked as active and in use containers at a Task level (not actual running tasks)
 *
 * @param {Config} config Global config object
 * @param {AWS.ECR} ecr ECR API
 * @param {AWS.ECS} ecs ECS API
 * @param {Array<string>} eligibleForDeletion Array of images to be filtered by active
 * @returns {Promise<AWS.ECR.ImageIdentifierList>}
 */
const filterOutActiveImages = (config, ecr, ecs, eligibleForDeletion) => {
  debug('BEFORE FILTER:', eligibleForDeletion)

  const listTaskDefinitions = utils.withNextToken(ecs.listTaskDefinitions, 'taskDefinitionArns', {
    status: 'ACTIVE'
  })
  return listTaskDefinitions([])
    .then(getAllImagesTagsByTaskDef(config, ecs))
    .then(activeImages => {
      const activeImagesFlatten = R.compose(R.uniq, R.flatten)(activeImages)
      debug('ACTIVE IMAGES:', activeImagesFlatten)

      // Remove images from deletion that are active
      return R.without(activeImagesFlatten, eligibleForDeletion)
    })
}

/**
 * Fetch all layers / image details from the repo
 * Filter out everything newer than some variable amount of days
 * set via REPO_AGE_THRESHOLD (90 days by default)
 *
 * @param {Config} config Global config object
 * @param {AWS.ECR} ecr ECR API
 * @param {AWS.ECR.ImageIdentifierList} images Array of images to be filtered by date
 * @returns {Promise<AWS.ECR.ImageIdentifierList>}
 */
const filterImagesByDateThreshold = (config, ecr, images) => {
  debug('IMAGES TO PROCESS (filterImagesByDateThreshold):', images)

  // No REPO_AGE_THRESHOLD so no images to filter
  if (!config.REPO_AGE_THRESHOLD) {
    return []
  }

  const describeImages = utils.withNextToken(ecr.describeImages, 'imageDetails', {
    imageIds: images,
    repositoryName: config.REPO_TO_CLEAN
  })

  return describeImages([]).then(imageDetails =>
    // Get all tags eligible for deletion by age threshold
    // coerce each of the tags to a full image reference for easy comparison
    imageDetails
      .map(image => {
        const created = image.imagePushedAt
        const imageTag = R.propOr('', 0, image.imageTags)
        if (created && imageTag !== 'latest' && utils.getImageAgeDays(created) >= config.REPO_AGE_THRESHOLD) {
          return utils.createRepoUrl(config, imageTag)
        }
        return null
      })
      .filter(R.identity)
  )
}

/**
 * Fetch all layers / image details from the repo
 * Filter out everything but the first n images
 * set via REPO_FIRST_N_THRESHOLD (3 by default)
 *
 * @param {Config} config Global config object
 * @param {AWS.ECR} ecr ECR API
 * @param {AWS.ECR.ImageIdentifierList} images Array of images to be filtered by n
 * @returns {Promise<AWS.ECR.ImageIdentifierList>}
 */
const filterImagesByFirstN = (config, ecr, images) => {
  debug('IMAGES TO PROCESS (filterImagesByFirstN):', images)

  // No REPO_FIRST_N_THRESHOLD so no images to filter
  if (!config.REPO_FIRST_N_THRESHOLD) {
    return []
  }

  const sortByCreated = R.sortBy(R.prop('created'))
  const groupByEnv = R.groupBy(image => {
    const tag = image.imageTag
    const tagEnv = (config.ENVS || []).find(env => R.contains(env, tag))
    return tagEnv || tag
  })

  const describeImages = utils.withNextToken(ecr.describeImages, 'imageDetails', {
    imageIds: images,
    repositoryName: config.REPO_TO_CLEAN
  })

  return describeImages([]).then(imageDetails => {
    // Get all tags eligible for deletion by age threshold
    // coerce each of the tags to a full image reference for easy comparison
    const imagesAndDays = imageDetails
      .map(image => {
        const created = image.imagePushedAt
        const imageTag = R.propOr('', 0, image.imageTags)

        return {
          created: created || -Infinity,
          imageTag
        }
      })
      .filter(R.identity)

    return R.compose(
      R.map(utils.createRepoUrl(config)),
      R.map(R.prop('imageTag')),
      R.unnest,
      R.values,
      R.map(R.dropLast(config.REPO_FIRST_N_THRESHOLD)),
      groupByEnv,
      sortByCreated
    )(imagesAndDays)
  })
}

module.exports = {
  getRepoImages: R.curry(getRepoImages),
  deleteImages: R.curry(deleteImages),
  filterOutActiveImages: R.curry(filterOutActiveImages),
  filterImagesByDateThreshold: R.curry(filterImagesByDateThreshold),
  filterImagesByFirstN: R.curry(filterImagesByFirstN)
}
