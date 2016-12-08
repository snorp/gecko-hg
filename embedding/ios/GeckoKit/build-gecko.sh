#!/bin/bash

set -e

die() {
    echo "Build failed."
    exit 1
}

GECKO_SRCROOT=${SRCROOT}/../../..

if test ${CONFIGURATION} == "Debug"; then
    BUILDTYPE=debug
else
    BUILDTYPE=opt
fi

if test ${ARCHS} == "x86_64"; then
    MOZCONFIG_TARGET=${SRCROOT}/configs/simulator-${BUILDTYPE}
elif test ${ARCHS} == "armv7"; then
    MOZCONFIG_TARGET=${SRCROOT}/configs/device-${BUILDTYPE}
else
    echo "Error: Invalid architecture: ${ARCHS}"
    exit 1
fi

echo "Building for arch: ${ARCHS}"

MOZCONFIG_PATH=${GECKO_SRCROOT}/mozconfig

DEP_LIBS="libnss3.dylib libmozglue.dylib liblgpllibs.dylib libfreebl3.dylib  libnssckbi.dylib  libsoftokn3.dylib libnssdbm3.dylib "

if test "${ACTION}" != "clean"; then
    echo "Building with OBJDIR = ${GECKO_OBJDIR}"
    echo "Using mozconfig $MOZCONFIG_TARGET"

    pushd ${GECKO_SRCROOT}
    ln -sf $MOZCONFIG_TARGET mozconfig
    env -i USER=$USER HOME=$HOME SHELL=$SHELL MOZ_OBJDIR=$GECKO_OBJDIR AUTOCLOBBER=1 bash -l -c './mach build && ./mach package' || die | tee build.log
    popd

    # The packaged GeckoKit has been stripped, even for debug builds (?), so don't use that
    rm ${GECKO_OBJDIR}/dist/geckokit/GeckoKit

    # Move over the main GeckoKit (libxul) library
    cp ${GECKO_OBJDIR}/dist/bin/GeckoKit ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}

    # We're going to put the $DEP_LIBS in GeckoKit.framework/Libraries
    mkdir -p ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Libraries

    # Copy dependent libs
    for x in $DEP_LIBS; do
        cp ${GECKO_OBJDIR}/dist/bin/$x ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Libraries

        # Change the location for this library in GeckoKit
        install_name_tool -change "@rpath/${x}" "@rpath/GeckoKit.framework/Libraries/${x}" ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/GeckoKit
    done;

    # Copy the application data into /Resources
    # mkdir -p ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Resources
    rsync --delete -a ${GECKO_OBJDIR}/dist/geckokit/ ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/browser/

    # mv ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/browser/GeckoKit ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}

    # Sign all of the libraries
    if test ${ARCHS} == "armv7"; then
        for x in $BUILT_PRODUCTS_DIR/$CONTENTS_FOLDER_PATH/Libraries/*.dylib $BUILT_PRODUCTS_DIR/$CONTENTS_FOLDER_PATH/GeckoKit; do
            echo "Signing $x"
            /usr/bin/codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --preserve-metadata=identifier,entitlements,resource-rules $x
        done
    fi

    cp ${GECKO_OBJDIR}/dist/include/GeckoWebView.h ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Headers
    cp ${GECKO_OBJDIR}/dist/include/GeckoThread.h ${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Headers


fi
