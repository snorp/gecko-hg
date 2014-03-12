#include "base/message_pump_roku.h"

namespace base {

MessagePumpForUI::MessagePumpForUI() {}
MessagePumpForUI::~MessagePumpForUI() {}
void MessagePumpForUI::Run(Delegate* delegate) {}
void MessagePumpForUI::Quit() {}
void MessagePumpForUI::ScheduleWork() {}
void MessagePumpForUI::ScheduleWorkForNestedLoop() { ScheduleWork(); };
void MessagePumpForUI::ScheduleDelayedWork(const TimeTicks& delayed_work_time) {}

}  // namespace base

