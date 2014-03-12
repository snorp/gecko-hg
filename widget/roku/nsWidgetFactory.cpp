/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/ModuleUtils.h"

#include "nsCOMPtr.h"
#include "nsWidgetsCID.h"
#include "nsAppShell.h"

#include "nsLookAndFeel.h"
#include "nsAppShellSingleton.h"

NS_DEFINE_NAMED_CID(NS_APPSHELL_CID);

static const mozilla::Module::CIDEntry kWidgetCIDs[] = {
  { &kNS_APPSHELL_CID, false, nullptr, nsAppShellConstructor },
  { nullptr }
};

static const mozilla::Module::ContractIDEntry kWidgetContracts[] = {
  { "@mozilla.org/widget/appshell/roku;1", &kNS_APPSHELL_CID },
  { nullptr }
};

static void
nsWidgetRokuModuleDtor()
{
    nsLookAndFeel::Shutdown();
    nsAppShellShutdown();
}

static const mozilla::Module kWidgetModule = {
    mozilla::Module::kVersion,
    kWidgetCIDs,
    kWidgetContracts,
    nullptr,
    nullptr,
    nsAppShellInit,
    nsWidgetRokuModuleDtor
};

NSMODULE_DEFN(nsWidgetRokuModule) = &kWidgetModule;
