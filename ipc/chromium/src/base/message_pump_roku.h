#ifndef BASE_MESSAGE_PUMP_ROKU_H_
#define BASE_MESSAGE_PUMP_ROKU_H_

#include "base/message_pump.h"

namespace base {

class TimeTicks;

class MessagePumpForUI : public MessagePump {
 public:
  MessagePumpForUI();
  virtual ~MessagePumpForUI();
  virtual void Run(Delegate* delegate);
  virtual void Quit();
  virtual void ScheduleWork();
  virtual void ScheduleWorkForNestedLoop();
  virtual void ScheduleDelayedWork(const TimeTicks& delayed_work_time);
};

}  // namespace base

#endif  // BASE_MESSAGE_PUMP_ROKU_H_
